import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Card, Empty, Select, Space, Spin, Table, Tag, Typography } from 'antd';
import { api } from '../api/client';
import { QueryErrorResult } from '../components/QueryErrorResult';
import { centsToWan } from '../utils/money';
import EChart, { type ChartSemanticClick } from '../components/EChart';
import { useAssistantPageContext } from '../assistant/contextHooks';
import { useOptionalAssistantRegistry } from '../assistant/AssistantContextRegistry';

interface MetricValueItem {
  id: number;
  code: string;
  name: string;
  kind: 'linear' | 'ratio';
  unit: string;
  displaySign: number;
  budgetCents: number | null;
  actualCents: number | null;
  budgetRatio: number | null;
  actualRatio: number | null;
}

interface VersionRow { id: number; year: number; name: string; status: string; is_current: 0 | 1; kind: string }

const RATIO_SCALE = 1_000_000;

/**
 * 指标趋势分析:选指标 × 选多版本,并行调用 /versions/:id/metric-values(React Query 并行,
 * 版本数一般 ≤5)。金额类值与端点返回值逐一相等(前端仅换算万元展示,不做二次计算);
 * 比率类为 RATIO_SCALE 定点比率,与「结构占比」页同口径;未冻结年度实际系列如实留空。
 */
export default function MetricTrend() {
  const { data: versions, error: versionsError, refetch: refetchVersions } = useQuery({
    queryKey: ['versions'],
    queryFn: () => api.get<VersionRow[]>('/versions'),
  });
  const [selectedVersionIds, setSelectedVersionIds] = useState<number[]>([]);
  const [selectedMetricIds, setSelectedMetricIds] = useState<number[]>([]);

  /* 小澧助手页面登记(§7.2 metric_trend)：指标与版本序列选择。 */
  useAssistantPageContext({
    pageKey: 'metric_trend',
    ready: true,
    scope: { metricId: selectedMetricIds.length === 1 ? selectedMetricIds[0] : undefined },
    view: { series: selectedMetricIds, versionIds: selectedVersionIds },
  });

  const effectiveVersionIds = useMemo(() => {
    if (selectedVersionIds.length) return selectedVersionIds;
    const current = versions?.find((v) => v.kind === 'budget' && v.is_current === 1);
    return current ? [current.id] : [];
  }, [selectedVersionIds, versions]);

  const metricQueries = useQueries({
    queries: effectiveVersionIds.map((id) => ({
      queryKey: ['metric-values', id],
      queryFn: () => api.get<{ items: MetricValueItem[] }>(`/versions/${id}/metric-values`),
      enabled: effectiveVersionIds.length > 0,
    })),
  });

  const loading = metricQueries.some((q) => q.isLoading);
  const metricError = metricQueries.find((q) => q.error)?.error;
  const firstItems = metricQueries[0]?.data?.items ?? [];
  const metricOptions = useMemo(() => firstItems.map((m) => ({
    value: m.id,
    label: `${m.code} ${m.name}${m.kind === 'ratio' ? ' (比率)' : ''}`,
  })), [firstItems]);

  const selectedMetrics = useMemo(
    () => firstItems.filter((m) => selectedMetricIds.includes(m.id)),
    [firstItems, selectedMetricIds],
  );

  /* 指标选项以 metricQueries[0](第一个版本)为基准。用户先选指标再改版本选择、
     导致版本顺序变化后,新第一个版本里可能缺少已选指标 id,selectedMetrics 静默清空、
     图表变空白而 Select 仍显示已选值。版本变化时清掉不在新基准里的选中项。 */
  useEffect(() => {
    setSelectedMetricIds((ids) => {
      const available = new Set(firstItems.map((m) => m.id));
      const kept = ids.filter((id) => available.has(id));
      return kept.length === ids.length ? ids : kept;
    });
  }, [firstItems]);

  const seriesRows = useMemo(() => {
    return effectiveVersionIds.map((versionId, idx) => {
      const version = versions?.find((v) => v.id === versionId);
      const items = metricQueries[idx]?.data?.items ?? [];
      const byId = new Map(items.map((m) => [m.id, m]));
      return { versionId, label: version ? `${version.year} · ${version.name}` : `版本 ${versionId}`, year: version?.year, byId };
    });
  }, [effectiveVersionIds, metricQueries, versions]);

  const fmtValue = (metric: MetricValueItem | undefined, which: 'budget' | 'actual'): string => {
    if (!metric) return '—';
    if (metric.kind === 'ratio') {
      const scaled = which === 'budget' ? metric.budgetRatio : metric.actualRatio;
      return scaled == null ? '不适用（分母为 0）' : `${(scaled / RATIO_SCALE * 100).toFixed(2)}%`;
    }
    const cents = which === 'budget' ? metric.budgetCents : metric.actualCents;
    if (cents == null) return '—';
    return centsToWan(cents * metric.displaySign);
  };
  const chartOption = useMemo(() => {
    const categories = seriesRows.map((row) => row.label);
    /* 金额与比率混选时必须双 Y 轴:两类量纲差几个数量级,共用单轴会把金额线
       压成一条直线,且 tooltip 默认显示原值无从分辨单位。金额走左轴(万元),
       比率走右轴(百分比),并在 tooltip 按系列补单位。 */
    const hasAmount = selectedMetrics.some((m) => m.kind !== 'ratio');
    const hasRatio = selectedMetrics.some((m) => m.kind === 'ratio');
    const dualAxis = hasAmount && hasRatio;
    const series = selectedMetrics.map((m) => ({
      name: `${m.code} ${m.name}`,
      type: 'line' as const,
      /* 3.4:期间离散数据不做点间插值 */
      smooth: false,
      ...(dualAxis && m.kind === 'ratio' ? { yAxisIndex: 1 } : {}),
      data: seriesRows.map((row) => {
        const item = row.byId.get(m.id);
        if (!item) return null;
        if (m.kind === 'ratio') {
          return item.budgetRatio == null ? null : Math.round(item.budgetRatio / RATIO_SCALE * 10000) / 100;
        }
        return item.budgetCents == null ? null : Math.round(item.budgetCents * m.displaySign / 10000) / 100;
      }),
    }));
    const metricKindByName = new Map<string, string>(selectedMetrics.map((m) => [`${m.code} ${m.name}`, m.kind]));
    return {
      tooltip: {
        trigger: 'axis',
        valueFormatter: (value: unknown, seriesName?: string) => {
          if (value == null || typeof value !== 'number') return '—';
          const kind = seriesName ? metricKindByName.get(seriesName) : undefined;
          return kind === 'ratio' ? `${value.toFixed(2)}%` : `${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 万元`;
        },
      },
      legend: { top: 0 },
      xAxis: { type: 'category', data: categories },
      yAxis: dualAxis
        ? [
            { type: 'value', name: '万元', position: 'left' as const },
            { type: 'value', name: '%', position: 'right' as const, splitLine: { show: false } },
          ]
        : { type: 'value' },
      series,
      grid: { top: 40, left: 60, right: dualAxis ? 60 : 20, bottom: 60 },
    };
  }, [seriesRows, selectedMetrics]);

  /* 图表点击 → chart_point(metric) 焦点(§8.4):系列名定位指标,x 轴类目定位版本标签。 */
  const assistantRegistry = useOptionalAssistantRegistry();
  const focusTokenRef = useRef<symbol | null>(null);
  const handleChartClick = useCallback((point: ChartSemanticClick) => {
    if (!assistantRegistry) return;
    const metric = selectedMetrics.find((m) => `${m.code} ${m.name}` === point.seriesKey);
    const versionRow = seriesRows.find((row) => row.label === point.name);
    if (!metric || !versionRow) return;
    if (focusTokenRef.current) assistantRegistry.clearFocus(focusTokenRef.current);
    focusTokenRef.current = assistantRegistry.setFocus(
      { kind: 'chart_point', seriesKey: 'metric_trend', dimensionType: 'metric', dimensionId: metric.id },
      `指标趋势 · ${metric.code} ${metric.name} · ${versionRow.label}`,
    );
  }, [assistantRegistry, selectedMetrics, seriesRows]);
  useEffect(() => () => {
    if (focusTokenRef.current) assistantRegistry?.clearFocus(focusTokenRef.current);
  }, [assistantRegistry]);

  return (
    <Card className="bd-root-card">
      <Space style={{ marginBottom: 12 }} wrap>
        <Typography.Text strong>预算版本</Typography.Text>
        <Select
          mode="multiple"
          showSearch optionFilterProp="label"
          style={{ minWidth: 320 }}
          placeholder="选择一个或多个版本(默认当前版本)"
          value={effectiveVersionIds}
          onChange={setSelectedVersionIds}
          options={(versions ?? []).map((v) => ({ value: v.id, label: `${v.year} · ${v.name}${v.is_current ? ' (当前)' : ''}` }))}
        />
        <Typography.Text strong>指标</Typography.Text>
        <Select
          mode="multiple"
          showSearch optionFilterProp="label"
          style={{ minWidth: 320 }}
          placeholder="选择一个或多个指标(金额类/比率类)"
          value={selectedMetricIds}
          onChange={setSelectedMetricIds}
          options={metricOptions}
          loading={loading}
        />
      </Space>
      {versionsError ? (
        <QueryErrorResult title="预算版本列表加载失败" error={versionsError} refetch={() => void refetchVersions()} />
      ) : loading ? (
        <div style={{ padding: 48, textAlign: 'center' }}><Spin /></div>
      ) : metricError ? (
        /* 失败不能显示「请选择指标」:指标选项缺失是加载失败,不是用户未选择 */
        <QueryErrorResult
          title="指标数据加载失败"
          error={metricError}
          refetch={() => metricQueries.forEach((q) => { if (q.error) void q.refetch(); })}
        />
      ) : selectedMetrics.length === 0 ? (
        <Empty description="请选择指标:金额类(linear)展示万元,比率类(ratio)展示百分比" />
      ) : (
        <>
          <EChart option={chartOption} height={360} onSemanticClick={handleChartClick} />
          <Table
            rowKey={(row) => String(row.versionId)}
            size="small"
            style={{ marginTop: 16 }}
            dataSource={seriesRows}
            pagination={false}
            columns={[
              { title: '版本', dataIndex: 'label', width: 220 },
              ...selectedMetrics.flatMap((m) => [
                {
                  title: `${m.code} ${m.name} · 预算${m.kind === 'ratio' ? '(%)' : '(万元)'}`,
                  key: `b-${m.id}`,
                  render: (_: unknown, row: (typeof seriesRows)[number]) => fmtValue(row.byId.get(m.id), 'budget'),
                },
              {
                title: `${m.code} ${m.name} · 实际`,
                key: `a-${m.id}`,
                render: (_: unknown, row: (typeof seriesRows)[number]) => {
                  const item = row.byId.get(m.id);
                  // null 表示无实际数据(未冻结/未录入),0 是合法实际值必须如实展示
                  const hasActual = item != null && (m.kind === 'ratio' ? item.actualRatio != null : item.actualCents != null);
                  return hasActual ? fmtValue(item, 'actual') : <Tag color="default">未冻结/无实际</Tag>;
                },
              },
              ]),
            ]}
          />
        </>
      )}
    </Card>
  );
}
