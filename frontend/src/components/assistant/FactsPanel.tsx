import { DOMAIN_TOOL_LABELS, DomainFactView } from './DomainFactView';
import { Link } from 'react-router-dom';
/**
 * 助手事实与引用展示。
 *
 * 所有数字都直接来自后端 facts，前端只做万元换算与排版，不重算金额、完成率或汇总。
 */
import { useMemo, useState } from 'react';
import { Collapse, Empty, Descriptions, Table, Tag, Tooltip, Typography, Space } from 'antd';
import type { AssistantCitation, AssistantFact } from '../../api/assistant';
import { centsToWan, formatRate, formatRateOrReason } from '../../utils/money';

const FACT_LABEL: Record<string, string> = {
  budget_versions: '预算/预测版本',
  actual_snapshots: '实际快照批次',
  actual_snapshot: '实际快照明细',
  org_tree: '组织树',
  account_tree: '科目树',
  import_batches: '导入批次',
  import_batch: '导入批次详情',
  operation_log: '操作日志',
  trend: '年内完成率趋势',
  version_variance: '版本对比',
  execution: '预算执行完成情况',
  report_summary: '报告摘要',
  report_draft: '报告草稿',
  attribution: '差异归因(逐层展开)',
  import_help: '导入诊断与匹配建议',
  budget_quality: '预算质量报告',
  anomalies: '异常与质量检查',
  accuracy: '预算准确率',
  historical_comparison: '历年对比',
  glossary: '业务解释',
  navigation: '页面导航',
  navigation_catalog: '可导航页面',
  cell_notes_budget: '预算单元格备注',
  cell_notes_actual: '实际数单元格备注',
  missing_context: '缺少条件',
  query_error: '查询未完成',
};

export function factLabel(type: string): string {
  if (type.startsWith('tool:')) return DOMAIN_TOOL_LABELS[type.slice(5)] ?? `只读工具 ${type.slice(5)}`;
  if (type.startsWith('insight:')) return `洞察 ${type.slice(8)}`;
  return FACT_LABEL[type] ?? type;
}

const SEVERITY_COLOR: Record<string, string> = { blocking: 'red', warning: 'orange', info: 'blue' };

function AnomalyTable({ data }: { data: any }) {
  const rows: any[] = Array.isArray(data?.anomalies) ? data.anomalies : [];
  return (
    <>
      <Descriptions size="small" column={2} style={{ marginBottom: 8 }}>
        <Descriptions.Item label="命中条数">{rows.length}</Descriptions.Item>
        <Descriptions.Item label="实际截至">{data?.asOfDate ?? '尚无实际批次'}</Descriptions.Item>
        <Descriptions.Item label="阈值">
          完成率 {formatRate(data?.threshold)} / 同比 {formatRate(data?.yoyThreshold)} / 同类 {formatRate(data?.peerThreshold)}
        </Descriptions.Item>
        <Descriptions.Item label="同比基准">
          {data?.previousYear?.year} 年（{data?.previousYear?.source === 'final' ? '最终快照' : data?.previousYear?.source === 'none' ? '无数据' : '当前累计'}）
        </Descriptions.Item>
      </Descriptions>
      <Table
        size="small"
        rowKey={(row: any, index) => `${row.code}-${row.accountId ?? row.orgId ?? 'total'}-${index}`}
        dataSource={rows}
        pagination={{ pageSize: 8, size: 'small' }}
        columns={[
          /* 规则码最长 26 字符 ≈224px:定宽 200 会被裁,按规范取 ~225 + 尾部省略 */
          { title: '规则', dataIndex: 'code', width: 225, ellipsis: { showTitle: false }, render: (code: string, row: any) => <Tooltip title={code}><Tag color={SEVERITY_COLOR[row.severity] ?? 'default'} style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>{code}</Tag></Tooltip> },
          { title: '维度', dataIndex: 'dimension', width: 70 },
          { title: '节点', width: 180, ellipsis: true, render: (_: unknown, row: any) => (row.nodeCode ? `${row.nodeCode} ${row.name ?? ''}` : row.name ?? '—') },
          { title: '预算(万元)', align: 'right' as const, width: 100, render: (_: unknown, row: any) => (row.cell ? centsToWan(row.cell.budgetCents) : '—') },
          { title: '实际(万元)', align: 'right' as const, width: 100, render: (_: unknown, row: any) => (row.cell ? centsToWan(row.cell.actualCents) : '—') },
          { title: '完成率', align: 'right' as const, width: 90, render: (_: unknown, row: any) => (row.cell ? formatRateOrReason(row.cell.rate, row.cell.rateSpecial) : '—') },
          { title: '判定依据', render: (_: unknown, row: any) => (
            <Space direction="vertical" size={0}>
              {(row.reasons ?? []).map((reason: string, i: number) => <Typography.Text key={i} style={{ fontSize: 12 }}>{reason}</Typography.Text>)}
              {row.basis && <Typography.Text type="secondary" style={{ fontSize: 12 }}>来源：{row.basis}</Typography.Text>}
            </Space>
          ) },
        ]}
        scroll={{ x: 900 }}
      />
    </>
  );
}

function ExecutionSummary({ data }: { data: any }) {
  const leaves: any[] = useMemo(
    () => [...(data?.analysisAccounts ?? [])].filter((row: any) => row.isLeaf)
      .sort((a: any, b: any) => Math.abs(b.cell.varianceCents) - Math.abs(a.cell.varianceCents)).slice(0, 15),
    [data],
  );
  return (
    <>
      <Descriptions size="small" column={2} style={{ marginBottom: 8 }}>
        <Descriptions.Item label="版本">{data?.version?.name}（{data?.version?.year}，{data?.version?.status}）</Descriptions.Item>
        <Descriptions.Item label="实际来源">{data?.actualSource}{data?.actualBatchId ? ` #${data.actualBatchId}` : ''}</Descriptions.Item>
        <Descriptions.Item label="实际截至">{data?.asOfDate ?? '尚无实际批次'}</Descriptions.Item>
        <Descriptions.Item label="时间进度">{data?.timeProgressValue == null ? '尚无实际批次，暂无时间进度基准' : formatRate(data.timeProgressValue)}</Descriptions.Item>
        <Descriptions.Item label="树口径" span={2}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{data?.treeBasis?.org}；{data?.treeBasis?.account}</Typography.Text>
        </Descriptions.Item>
      </Descriptions>
      <Table
        size="small"
        rowKey="accountId"
        dataSource={leaves}
        pagination={false}
        columns={[
          { title: '科目', render: (_: unknown, row: any) => `${row.code} ${row.name}` },
          { title: '类型', dataIndex: 'type', width: 70 },
          { title: '预算(万元)', align: 'right' as const, render: (_: unknown, row: any) => centsToWan(row.cell.budgetCents) },
          { title: '实际(万元)', align: 'right' as const, render: (_: unknown, row: any) => centsToWan(row.cell.actualCents) },
          { title: '差异(万元)', align: 'right' as const, render: (_: unknown, row: any) => centsToWan(row.cell.varianceCents) },
          { title: '完成率', align: 'right' as const, render: (_: unknown, row: any) => formatRateOrReason(row.cell.rate, row.cell.rateSpecial) },
        ]}
        scroll={{ x: 640 }}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>按差异绝对值取前 15 条；完整明细见「年度执行分析」页面。</Typography.Text>
    </>
  );
}

function GlossaryFact({ data }: { data: any }) {
  const entries: any[] = Array.isArray(data?.entries) ? data.entries : [];
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      {entries.map((entry) => (
        <div key={entry.key}>
          <Typography.Text strong>{entry.term}</Typography.Text>
          <Typography.Paragraph style={{ marginBottom: 4, whiteSpace: 'pre-wrap' }}>{entry.text}</Typography.Paragraph>
          {Array.isArray(entry.examples) && entry.examples.length > 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>示例：{entry.examples.join('；')}</Typography.Text>
          )}
          {entry.reference && <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>口径来源：{entry.reference}</Typography.Text></div>}
        </div>
      ))}
    </Space>
  );
}

function AttributionFact({ data }: { data: any }) {
  const leaves: any[] = [...(data?.rankedAccountLeaves ?? []), ...(data?.rankedOrgLeaves ?? [])];
  return (
    <>
      <Descriptions size="small" column={2} style={{ marginBottom: 8 }}>
        <Descriptions.Item label="版本">{data?.version?.name}（{data?.version?.year}）</Descriptions.Item>
        <Descriptions.Item label="实际截至">{data?.asOfDate ?? '尚无实际批次'}</Descriptions.Item>
        <Descriptions.Item label="预算合计(万元)">{centsToWan(data?.totals?.budgetCents ?? 0)}</Descriptions.Item>
        <Descriptions.Item label="实际合计(万元)">{centsToWan(data?.totals?.actualCents ?? 0)}</Descriptions.Item>
        <Descriptions.Item label="净差异(万元)">{centsToWan(data?.totals?.varianceCents ?? 0)}</Descriptions.Item>
        <Descriptions.Item label="守恒核对">
          {data?.reconciliation?.matched && data?.reconciliation?.unreconciledNodeCount === 0
            ? <Tag color="green">两维度一致</Tag>
            : <Tag color="orange">不一致，请检查范围</Tag>}
        </Descriptions.Item>
      </Descriptions>
      <Table
        size="small"
        rowKey={(row: any) => `${row.dimension}-${row.id}`}
        dataSource={leaves}
        pagination={{ pageSize: 8, size: 'small' }}
        columns={[
          { title: '维度', dataIndex: 'dimension', width: 70, render: (value: string) => (value === 'org' ? '组织' : '科目') },
          { title: '节点', render: (_: unknown, row: any) => <Tooltip title={row.path}>{`${row.code} ${row.name}`}</Tooltip> },
          { title: '差异(万元)', align: 'right' as const, width: 110, render: (_: unknown, row: any) => centsToWan(row.varianceCents) },
          { title: '方向', width: 70, render: (_: unknown, row: any) => (row.favorable === 'favorable' ? <Tag color="green">有利</Tag> : row.favorable === 'unfavorable' ? <Tag color="red">不利</Tag> : <Tag>持平</Tag>) },
          { title: '完成率', align: 'right' as const, width: 90, render: (_: unknown, row: any) => formatRateOrReason(row.rate, row.rateSpecial) },
          { title: '占总差异', align: 'right' as const, width: 90, render: (_: unknown, row: any) => (row.shareOfTotal == null ? '—' : `${(Math.abs(row.shareOfTotal) * 100).toFixed(1)}%`) },
        ]}
        scroll={{ x: 760 }}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>完整逐层展开请点击页面顶部「差异归因」。</Typography.Text>
    </>
  );
}

function ReportDraftFact({ data }: { data: any }) {
  const sections: any[] = Array.isArray(data?.sections) ? data.sections : [];
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space size={6} wrap>
        <Typography.Text strong>{data?.title}</Typography.Text>
        <Tag color="blue">{data?.kindLabel}</Tag>
        <Tag>{data?.narrativeSource === 'model' ? '叙述由模型改写' : '模板叙述'}</Tag>
      </Space>
      {sections.map((section) => (
        <div key={section.key}>
          <Typography.Text strong style={{ fontSize: 13 }}>{section.title}</Typography.Text>
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            {(section.bullets ?? []).map((bullet: string, index: number) => (
              <Typography.Text key={index} style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>· {bullet}</Typography.Text>
            ))}
          </Space>
        </div>
      ))}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>完整成稿与逐节引用请点击页面顶部「报告生成」。</Typography.Text>
    </Space>
  );
}

function ImportHelpFact({ data }: { data: any }) {
  const groups: any[] = Array.isArray(data?.groups) ? data.groups : [];
  const unmatched: any[] = [...(data?.unmatched?.org ?? []), ...(data?.unmatched?.account ?? [])];
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Descriptions size="small" column={3}>
        <Descriptions.Item label="错误条数">{data?.errorCount ?? 0}</Descriptions.Item>
        <Descriptions.Item label="未匹配编码">{unmatched.length}</Descriptions.Item>
        <Descriptions.Item label="重复行">{data?.duplicates?.length ?? 0}</Descriptions.Item>
      </Descriptions>
      <Table
        size="small"
        rowKey="category"
        dataSource={groups}
        pagination={false}
        columns={[
          { title: '错误类型', render: (_: unknown, row: any) => <Space size={6}><Tag color="red">{row.count}</Tag>{row.label}</Space> },
          { title: '处理建议', dataIndex: 'fix', ellipsis: true },
        ]}
      />
      {unmatched.length ? (
        <Table
          size="small"
          rowKey={(row: any) => `${row.kind}-${row.code}`}
          dataSource={unmatched}
          pagination={false}
          columns={[
            { title: '类型', dataIndex: 'kind', width: 70, render: (value: string) => (value === 'org' ? '组织' : '科目') },
            /* 文件来源编码长度不受控:nowrap + 尾部省略 + Tooltip,不折行撑高 */
            { title: '文件编码', dataIndex: 'code', width: 140, ellipsis: { showTitle: false }, render: (value: string) => <Tooltip title={value}><Typography.Text code>{value}</Typography.Text></Tooltip> },
            { title: '候选建议', render: (_: unknown, row: any) => (row.candidates ?? []).map((c: any) => `${c.code} ${c.name}(${(c.score * 100).toFixed(0)}%)`).join('、') || '无相似候选' },
          ]}
          scroll={{ x: 560 }}
        />
      ) : null}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>完整清单与采纳操作请点击页面顶部「导入辅助」。</Typography.Text>
    </Space>
  );
}

function RawJson({ data }: { data: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const text = useMemo(() => JSON.stringify(data, null, 2), [data]);
  const truncated = text.length > 2_000 && !expanded;
  return (
    <>
      <pre style={{ margin: 0, maxHeight: 320, overflow: 'auto', fontSize: 12, whiteSpace: 'pre-wrap' }}>
        {truncated ? `${text.slice(0, 2_000)}\n…` : text}
      </pre>
      {text.length > 2_000 && (
        <Typography.Link style={{ fontSize: 12 }} onClick={() => setExpanded((v) => !v)}>{expanded ? '收起' : '展开完整事实'}</Typography.Link>
      )}
    </>
  );
}

function FactBody({ fact }: { fact: AssistantFact }) {
  const data: any = fact.data;
  if (fact.type === 'anomalies' || fact.type === 'tool:calculate_anomalies') return <AnomalyTable data={data} />;
  if (fact.type === 'attribution' || fact.type === 'tool:calculate_attribution' || fact.type === 'insight:attribution') return <AttributionFact data={data} />;
  if (fact.type === 'report_draft' || fact.type === 'tool:generate_report' || fact.type === 'insight:report') return <ReportDraftFact data={data} />;
  if (fact.type === 'import_help' || fact.type === 'tool:explain_import') return <ImportHelpFact data={data} />;
  if (fact.type === 'execution' || fact.type === 'tool:calculate_execution') return <ExecutionSummary data={data} />;
  if (fact.type === 'glossary' || fact.type === 'tool:explain_terms') return <GlossaryFact data={fact.type === 'glossary' ? data : { entries: data?.matched }} />;
  if (fact.type.startsWith('tool:') && DOMAIN_TOOL_LABELS[fact.type.slice(5)]) return <DomainFactView fact={fact} />;
  if (fact.type.startsWith('domain_')) return <DomainFactView fact={fact} />;
  return <RawJson data={data} />;
}

export function FactsPanel({ facts }: { facts: AssistantFact[] }) {
  if (!facts.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本次回答没有结构化事实" />;
  return (
    <Collapse
      size="small"
      items={facts.map((fact, index) => ({
        key: String(index),
        label: (
          <Space size={6}>
            <Tag color="blue">事实</Tag>
            <span>{factLabel(fact.type)}</span>
            {fact.source?.budgetVersionId ? <Tag>版本 #{fact.source.budgetVersionId}</Tag> : null}
            {fact.source?.actualSnapshotId ? <Tag>快照 #{fact.source.actualSnapshotId}</Tag> : null}
          </Space>
        ),
        children: <FactBody fact={fact} />,
      }))}
    />
  );
}

export function CitationList({ citations }: { citations: AssistantCitation[] }) {
  if (!citations.length) return null;
  return (
    <Space size={[4, 4]} wrap>
      {citations.map((citation, index) => (
        <Tooltip
          key={index}
          title={
            <div style={{ fontSize: 12 }}>
              <div>来源：{factLabel(citation.source)}</div>
              <div>截至：{citation.asOf}</div>
              {citation.period && <div>期间：{citation.period}</div>}
              {citation.references?.map((r) => <div key={`${r.kind}:${r.id}`}>{r.label} #{r.id}{r.hash ? ` · ${r.hash}` : ''}</div>)}
              {citation.year != null && <div>年度：{citation.year}</div>}
              {citation.budgetVersionId != null && <div>预算版本：#{citation.budgetVersionId}</div>}
              {citation.targetVersionId != null && <div>对比版本：#{citation.targetVersionId}</div>}
              {citation.actualSnapshotId != null && <div>实际快照：#{citation.actualSnapshotId}</div>}
              {citation.treeSnapshotIds?.org != null && <div>组织树快照：#{citation.treeSnapshotIds.org}</div>}
              {citation.treeSnapshotIds?.account != null && <div>科目树快照：#{citation.treeSnapshotIds.account}</div>}
            </div>
          }
        >
          <Tag style={{ cursor: 'help' }}>
            [{index + 1}] {factLabel(citation.source)}
            {citation.period ? ` · ${citation.period}` : ''}
            {citation.budgetVersionId != null ? ` · V#${citation.budgetVersionId}` : ''}
            {citation.actualSnapshotId != null ? ` · S#${citation.actualSnapshotId}` : ''}
          </Tag>
        </Tooltip>
      ))}
      {citations.flatMap((c) => c.references ?? []).filter((r, i, a) => a.findIndex((x) => x.kind === r.kind && x.id === r.id) === i).map((r) => <Link key={`${r.kind}:${r.id}`} to={r.path}>{r.label}</Link>)}
    </Space>
  );
}
