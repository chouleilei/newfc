import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Empty, Form, InputNumber, Select, Space, Spin, Table, Tag, Tooltip, Typography } from 'antd';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { QueryErrorResult } from '../components/QueryErrorResult';
import { TechDetail } from '../components/TechDetail';
import { CODE_WIDTH, codeColumn } from '../utils/tableColumns';
import { useAssistantPageContext } from '../assistant/contextHooks';
import { useOptionalAssistantRegistry } from '../assistant/AssistantContextRegistry';
import { useAssistant } from '../assistant/AssistantProvider';
import { useUrlScopeSync } from '../hooks/useUrlScopeSync';
import { anomalyLocateScope } from '../utils/analysisLocate';
import { buildScopeSearch, type ScopeIssue } from '../utils/workspaceScope';

type Severity = 'blocking' | 'warning' | 'info';
type Dimension = 'account' | 'org' | 'total' | 'quality';

interface AnomalyItem {
  code: string;
  severity: Severity;
  dimension: Dimension;
  reasons: string[];
  accountId?: number;
  orgId?: number;
  nodeCode?: string;
  name?: string;
  type?: string;
  metrics?: Record<string, unknown>;
  basis?: string;
}

const SEVERITY_META: Record<Severity, { label: string; color: string; order: number }> = {
  blocking: { label: '阻断', color: 'red', order: 0 },
  warning: { label: '提醒', color: 'orange', order: 1 },
  info: { label: '观察', color: 'blue', order: 2 },
};

const DIMENSION_LABEL: Record<Dimension, string> = {
  account: '科目',
  org: '组织',
  total: '总计',
  quality: '质量',
};

/** 预警依据 metrics 键的业务化标签与比率格式化;未识别的内部键(rule、ID 等)只留在「技术详情」。 */
const METRIC_LABEL: Record<string, string> = {
  rate: '完成率', baseline: '基线', deviation: '偏离', threshold: '阈值',
  growth: '同比波动', peerMedian: '同类中位数', peerCount: '同类数量',
  budgetDisplay: '预算额', currentDisplay: '本期', previousDisplay: '对比期',
  asOfDate: '数据截止', previousAsOfDate: '对比期截止', previousYear: '对比年度',
  comparison: '对比口径', yearClosed: '年度已关闭',
  quantityRate: '数量完成率', amountRate: '金额完成率', incomeRate: '收入完成率',
};
const RATE_KEYS = new Set(['rate', 'baseline', 'deviation', 'threshold', 'growth', 'peerMedian', 'quantityRate', 'amountRate', 'incomeRate']);
const COMPARISON_LABEL: Record<string, string> = { full_year: '全年', same_period: '同期' };

function summarizeAnomalyMetrics(metrics: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(metrics)) {
    const label = METRIC_LABEL[key];
    if (!label || value == null) continue;
    if (typeof value === 'number') parts.push(`${label} ${RATE_KEYS.has(key) ? `${(value * 100).toFixed(1)}%` : value}`);
    else if (typeof value === 'boolean') parts.push(`${label}:${value ? '是' : '否'}`);
    else parts.push(`${label} ${key === 'comparison' ? (COMPARISON_LABEL[String(value)] ?? String(value)) : String(value)}`);
  }
  return parts.join('；');
}

/**
 * 预警中心:确定性异常检测独立页。
 * 与助手「异常与质量检查」调用同一个后端 anomalyReport;
 * 走 /api/analysis/anomalies 普通路由,不消耗助手限流、不依赖模型配置。
 * 已应用阈值随 URL 恢复(UX-02);未点「应用」的输入不进入查询参数。
 */
export default function AnomalyCenter() {
  const { data: versions, error: versionsError, refetch: refetchVersions } = useQuery({
    queryKey: ['versions'],
    queryFn: () => api.get<{ id: number; year: number; name: string; status: string; is_current: 0 | 1; kind: string }[]>('/versions'),
  });
  const [versionId, setVersionId] = useState<number | undefined>();
  /** URL 显式指定的年度/版本(待归属校验);版本缺失时按 URL 年度选该年当前预算版本。
      用 state 而不是 ref:页内前进/后退换 URL 时也要重新走归属校验。 */
  const [urlScope, setUrlScope] = useState<{ year?: number; version?: number }>({});
  const effectiveVersionId = versionId
    ?? (urlScope.year != null
      ? versions?.find((v) => v.kind === 'budget' && v.is_current === 1 && v.year === urlScope.year)?.id
        ?? versions?.find((v) => v.year === urlScope.year)?.id
      : undefined)
    ?? versions?.find((v) => v.kind === 'budget' && v.is_current === 1)?.id
    ?? versions?.[0]?.id;
  const year = versions?.find((v) => v.id === effectiveVersionId)?.year;

  const { data: batches } = useQuery({
    queryKey: ['batches-for-analysis', year],
    enabled: year != null,
    queryFn: () => api.get<{ id: number; snapshot_date: string; status: string }[]>(`/actual/batches?year=${year}`),
  });
  const [batchId, setBatchId] = useState<number | null>(null);
  const [threshold, setThreshold] = useState(20);
  const [yoyThreshold, setYoyThreshold] = useState(30);
  const [peerThreshold, setPeerThreshold] = useState(30);
  const [applied, setApplied] = useState({ threshold: 0.2, yoyThreshold: 0.3, peerThreshold: 0.3 });

  /* URL 范围契约(UX-02):year/version/batch/threshold 进 URL;threshold 只镜像「已应用」
     的阈值,正在输入的值不进查询参数(输入与应用由「应用」按钮分开)。 */
  const [scopeIssues, setScopeIssues] = useState<ScopeIssue[]>([]);
  /** 当前 batchId 是否来自 URL 显式参数(失效清理时决定是否给出可见说明) */
  const batchFromUrlRef = useRef(false);
  const latchScopeIssues = (issues: ScopeIssue[]) => {
    if (issues.length === 0) return;
    setScopeIssues((prev) => [...prev, ...issues.filter((issue) => !prev.some((p) => p.key === issue.key && p.raw === issue.raw))]);
  };
  useUrlScopeSync('anomaly_center', {
    year,
    budgetVersionId: effectiveVersionId,
    actualSnapshotId: batchId ?? undefined,
    threshold: Math.round(applied.threshold * 100),
  }, (parsed) => {
    latchScopeIssues(parsed.issues);
    const s = parsed.scope;
    setUrlScope({ year: s.year, version: s.budgetVersionId });
    if (s.actualSnapshotId != null) {
      batchFromUrlRef.current = true;
      setBatchId((prev) => (prev === s.actualSnapshotId ? prev : s.actualSnapshotId!));
    }
    if (s.threshold != null) {
      setThreshold(s.threshold);
      setApplied((prev) => (prev.threshold === s.threshold! / 100 ? prev : { ...prev, threshold: s.threshold! / 100 }));
    }
  });

  /* 归属校验:URL 版本必须存在;版本与年度同时显式给出时必须一致(不静默换目标);
     仅给年度时该年度必须确有版本,否则提示并按默认版本显示 */
  useEffect(() => {
    if (!versions) return;
    const { year: urlYear, version: urlVersion } = urlScope;
    if (urlVersion == null) {
      if (urlYear != null && !versions.some((v) => v.year === urlYear)) {
        latchScopeIssues([{ key: 'year', field: 'year', raw: String(urlYear), reason: 'not_found', detail: `链接中的 ${urlYear} 年没有任何预算版本,已显示默认版本` }]);
        setUrlScope((prev) => ({ ...prev, year: undefined }));
      }
      return;
    }
    const found = versions.find((v) => v.id === urlVersion);
    if (!found) {
      latchScopeIssues([{ key: 'version', field: 'budgetVersionId', raw: String(urlVersion), reason: 'not_found', detail: `链接中的预算版本 ${urlVersion} 不存在或已删除,已显示默认版本` }]);
    } else if (urlYear != null && found.year !== urlYear) {
      latchScopeIssues([{ key: 'version', field: 'budgetVersionId', raw: String(urlVersion), reason: 'scope_mismatch', detail: `链接中的预算版本 ${urlVersion} 属于 ${found.year} 年,与年度参数 ${urlYear} 不一致,已按版本年度显示` }]);
      setVersionId(urlVersion);
    } else {
      setVersionId((prev) => (prev === urlVersion ? prev : urlVersion));
    }
    setUrlScope((prev) => ({ ...prev, version: undefined }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versions, urlScope]);

  // 年度切换后旧年度快照 ID 必须清掉:残留 ID 不在新年度批次里,
  // 会把助手上下文带成「year=新年度 + 旧年度快照」的冲突组合(后端 409)。
  // 显式 URL 指定的快照被清除时给出可见说明(跨年度快照不可混用)。
  useEffect(() => {
    if (batchId != null && batches != null && !batches.some((b) => b.id === batchId)) {
      if (batchFromUrlRef.current) {
        latchScopeIssues([{ key: 'batch', field: 'actualSnapshotId', raw: String(batchId), reason: 'scope_mismatch', detail: `链接中的实际快照 ${batchId} 不属于 ${year ?? '所选'} 年,已改用当前累计` }]);
        batchFromUrlRef.current = false;
      }
      setBatchId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batches, batchId]);

  /* 财务助手页面登记(§7.2 anomaly_center)：版本/快照与三个阈值的生效值。 */
  useAssistantPageContext({
    pageKey: 'anomaly_center',
    ready: effectiveVersionId != null,
    notReadyReason: versionsError ? '预算版本列表读取失败' : '正在读取预算版本列表',
    readyState: versionsError ? 'error' : 'loading',
    scope: {
      year,
      budgetVersionId: effectiveVersionId,
      actualSnapshotId: batchId ?? undefined,
    },
    view: { threshold: applied.threshold * 100, yoyThreshold: applied.yoyThreshold * 100, peerThreshold: applied.peerThreshold * 100 },
  });

  const { data, isLoading, isFetching, error: anomalyError, refetch: refetchAnomalies } = useQuery({
    queryKey: ['anomalies', effectiveVersionId, batchId, applied],
    enabled: effectiveVersionId != null,
    queryFn: () => {
      const q = new URLSearchParams({ versionId: String(effectiveVersionId) });
      if (batchId != null) q.set('batchId', String(batchId));
      q.set('threshold', String(applied.threshold));
      q.set('yoyThreshold', String(applied.yoyThreshold));
      q.set('peerThreshold', String(applied.peerThreshold));
      return api.get<{ anomalies: AnomalyItem[]; anomalyCount: number }>(`/analysis/anomalies?${q}`);
    },
  });

  const items: AnomalyItem[] = useMemo(() => data?.anomalies ?? [], [data]);

  /* 按级别分组的计数(前端派生):阻塞→红、提醒→橙、观察→绿,配状态圆图标 */
  const severityCounts = useMemo(() => ({
    blocking: items.filter((item) => item.severity === 'blocking').length,
    warning: items.filter((item) => item.severity === 'warning').length,
    info: items.filter((item) => item.severity === 'info').length,
  }), [items]);

  const grouped = useMemo(() => {
    const sorted = [...items].sort((a, b) => SEVERITY_META[a.severity].order - SEVERITY_META[b.severity].order);
    return sorted;
  }, [items]);

  /**
   * 预警 → 分析(UX-03):携带当前预警同口径的年度/预算版本/实际快照与对象,
   * 走分析页现有参数契约;分析页负责展开、定位并对失效对象给出原因。
   */
  const analysisLocatePath = (row: AnomalyItem): string => {
    const search = buildScopeSearch('analysis', {
      year,
      budgetVersionId: effectiveVersionId,
      actualSnapshotId: batchId ?? undefined,
      ...anomalyLocateScope(row),
    });
    return `/analysis${search ? `?${search}` : ''}`;
  };

  /**
   * 预警行「问助手解释」(UX-26):把该行对象登记为助手当前焦点并打开小窗提问;
   * 提问仍经 send → buildSnapshot 冻结本页范围(版本/快照/阈值)后发送。
   */
  const assistantRegistry = useOptionalAssistantRegistry();
  const { openDock, send, sending } = useAssistant();
  const askAssistantAbout = (row: AnomalyItem) => {
    if (sending) return;
    const entityId = row.dimension === 'account' ? row.accountId : row.dimension === 'org' ? row.orgId : undefined;
    const target = `${DIMENSION_LABEL[row.dimension]} ${[row.nodeCode, row.name].filter(Boolean).join(' ')}`.trim();
    if (assistantRegistry && entityId != null && (row.dimension === 'account' || row.dimension === 'org')) {
      assistantRegistry.setFocus({ kind: 'entity', entityType: row.dimension, id: entityId }, target);
    }
    openDock();
    void send(`解释这条异常预警（${SEVERITY_META[row.severity].label} · ${target} · ${row.code}）的原因和处理建议`);
  };

  return (
    <Card className="newfc-root-card">
      {scopeIssues.length > 0 && (
        <Alert
          type="warning"
          showIcon
          closable
          style={{ marginBottom: 12 }}
          onClose={() => setScopeIssues([])}
          message="链接中的范围参数已忽略"
          description={scopeIssues.map((issue) => issue.detail).join('；')}
        />
      )}
      {versionsError ? (
        <QueryErrorResult title="预算版本列表加载失败" error={versionsError} refetch={() => void refetchVersions()} />
      ) : anomalyError ? (
        /* 失败不能落到「未发现异常」:那是结论性文案,必须由成功响应支撑 */
        <QueryErrorResult title="异常检测加载失败" error={anomalyError} refetch={() => void refetchAnomalies()} />
      ) : (
      <>
      {/* 汇总行:三档状态圆图标 + 计数,先给一屏结论再进表格 */}
      {!isLoading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap', marginBottom: 12 }} data-testid="anomaly-summary">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span className="newfc-status-icon newfc-status-icon-bad"><i className="ri-close-line" aria-hidden /></span>
            <Typography.Text>阻塞 <Typography.Text strong className="tabular-numbers">{severityCounts.blocking}</Typography.Text></Typography.Text>
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span className="newfc-status-icon newfc-status-icon-warn"><i className="ri-alert-line" aria-hidden /></span>
            <Typography.Text>提醒 <Typography.Text strong className="tabular-numbers">{severityCounts.warning}</Typography.Text></Typography.Text>
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span className="newfc-status-icon newfc-status-icon-ok"><i className="ri-check-line" aria-hidden /></span>
            <Typography.Text>观察 <Typography.Text strong className="tabular-numbers">{severityCounts.info}</Typography.Text></Typography.Text>
          </span>
        </div>
      )}
      <Space style={{ marginBottom: 12 }} wrap>
        <Typography.Text strong>预算版本</Typography.Text>
        <Select
          showSearch optionFilterProp="label" style={{ width: 240 }}
          value={effectiveVersionId} onChange={setVersionId}
          options={(versions ?? []).map((v) => ({ value: v.id, label: `${v.year} · ${v.name}${v.is_current ? ' (当前)' : ''}` }))}
        />
        <Typography.Text strong>实际快照</Typography.Text>
        <Select<number | null>
          style={{ width: 200 }}
          value={batchId}
          onChange={(value) => setBatchId(value ?? null)}
          options={[
            { value: null, label: '当前累计' },
            ...(batches ?? []).map((b) => ({ value: b.id, label: `快照 ${b.snapshot_date}${b.status === 'final' ? ' (冻结)' : ''}` })),
          ]}
        />
      </Space>
      <Form layout="inline" style={{ marginBottom: 12 }} onFinish={() => setApplied({ threshold: threshold / 100, yoyThreshold: yoyThreshold / 100, peerThreshold: peerThreshold / 100 })}>
        <Form.Item label="完成率偏离阈值(%)">
          <InputNumber min={0} max={1000} value={threshold} onChange={(v) => setThreshold(v ?? 20)} />
        </Form.Item>
        <Form.Item label="同比波动阈值(%)">
          <InputNumber min={0} max={1000} value={yoyThreshold} onChange={(v) => setYoyThreshold(v ?? 30)} />
        </Form.Item>
        <Form.Item label="同类偏离阈值(%)">
          <InputNumber min={0} max={1000} value={peerThreshold} onChange={(v) => setPeerThreshold(v ?? 30)} />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={isFetching}>应用</Button>
        </Form.Item>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          阈值在「应用」后生效并进入链接,输入中的值不影响查询;口径差超过 7 天的同期对比会在原因中如实标注跳过。
        </Typography.Text>
      </Form>
      {isLoading ? <Spin /> : grouped.length === 0 ? (
        <Empty description="未发现异常:空值、反向、离群与口径问题均未命中" />
      ) : (
        <Table<AnomalyItem>
          rowKey={(row, i) => `${row.code}:${row.dimension}:${row.nodeCode ?? ''}:${i}`}
          size="small"
          dataSource={grouped}
          pagination={{ pageSize: 50, showSizeChanger: false }}
          scroll={{ x: 1080 }}
          columns={[
            {
              title: '级别',
              dataIndex: 'severity',
              width: 80,
              render: (v: Severity) => <Tag color={SEVERITY_META[v].color}>{SEVERITY_META[v].label}</Tag>,
            },
            {
              title: '维度',
              dataIndex: 'dimension',
              width: 80,
              render: (v: Dimension) => <Tag>{DIMENSION_LABEL[v]}</Tag>,
            },
            codeColumn<AnomalyItem>({ title: '规则', dataIndex: 'code', width: CODE_WIDTH.anomalyRule }),
            {
              title: '对象',
              key: 'target',
              width: 220,
              /* 芯片与链接 nowrap,名称可截断(Tooltip 看全文),整列保持单行(方案三.1) */
              onCell: () => ({ style: { whiteSpace: 'nowrap' } }),
              render: (_, row) => (
                <Space size={6}>
                  <Typography.Text code style={{ fontSize: 12 }}>{row.nodeCode ?? '—'}</Typography.Text>
                  <Tooltip title={row.name}>
                    <span style={{ display: 'inline-block', maxWidth: 92, overflow: 'hidden', textOverflow: 'ellipsis', verticalAlign: 'bottom' }}>{row.name ?? ''}</span>
                  </Tooltip>
                  {(row.dimension === 'account' || row.dimension === 'org') && (
                    <Link to={analysisLocatePath(row)}>定位到年度执行分析</Link>
                  )}
                  <Typography.Link
                    style={{ fontSize: 12, whiteSpace: 'nowrap' }}
                    disabled={sending}
                    data-testid="anomaly-ask-assistant"
                    onClick={() => askAssistantAbout(row)}
                  >
                    问助手解释
                  </Typography.Link>
                </Space>
              ),
            },
            {
              title: '原因',
              dataIndex: 'reasons',
              render: (reasons: string[]) => (
                <div>{reasons.map((r, i) => <div key={i} style={{ fontSize: 12 }}>· {r}</div>)}</div>
              ),
            },
            {
              title: '依据',
              key: 'metrics',
              width: 220,
              /* 依据先给业务摘要(完成率、阈值、截止日等);原始 JSON 收进「技术详情」供核对(UX-27) */
              render: (_, row) => {
                if (row.metrics) {
                  const summary = summarizeAnomalyMetrics(row.metrics);
                  return <TechDetail summary={<Typography.Text style={{ fontSize: 12 }}>{summary || '—'}</Typography.Text>} raw={row.metrics} />;
                }
                return <Typography.Text code style={{ fontSize: 12 }}>{row.basis ?? ''}</Typography.Text>;
              },
            },
          ]}
        />
      )}
      </>
      )}
    </Card>
  );
}
