import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, Tag, Typography, Button, Alert, Result, Space, Tooltip, Segmented } from 'antd';
import { EnhancedTable as Table } from '../components/EnhancedTable';
import { api, download } from '../api/client';
import { centsToWan, formatRate } from '../utils/money';
import MoneyText from '../components/MoneyText';
import EChart, { type ChartSemanticClick } from '../components/EChart';
import { wanAxisLabel, chartTheme, useThemeMode, financeColor } from '../theme';
import { useAssistantPageContext } from '../assistant/contextHooks';
import { useOptionalAssistantRegistry } from '../assistant/AssistantContextRegistry';

interface YearRow {
  year: number;
  budgetVersionName: string | null;
  budgetVersionId: number | null;
  finalSnapshotDate: string | null;
  totals: {
    incomeBudget: number; incomeActual: number;
    costBudget: number; costActual: number;
    expenseBudget: number; expenseActual: number;
    profitBudget: number; profitActual: number;
  };
  varianceProfit: number;
  rateIncome: number | null;
  rateProfit: number | null;
  yoyProfit: number | null;
  accuracyProfit: number | null;
}

/** AI 功能增强计划阶段五:N 年同口径对比(编码对齐 + 可比性声明 + 维度下探) */
interface MultiYearTrend {
  baseYear: number;
  years: { year: number; comparable: boolean; reason?: string; source: string; asOfDate: string | null; batchId: number | null }[];
  accounts: { code: string; name: string; type: string; values: Record<number, number>; yoy: Record<number, number | null> }[];
  orgs: { code: string; name: string; values: Record<number, number>; yoy: Record<number, number | null> }[];
  comparability: {
    matchedAccountCodes: string[]; addedAccountCodes: string[]; removedAccountCodes: string[];
    matchedOrgCodes: string[]; addedOrgCodes: string[]; removedOrgCodes: string[];
    notes: string[];
  };
}

function MultiYearTrendCard(props: { baseYear: number }) {
  const [dimension, setDimension] = useState<'account' | 'org'>('account');
  const { data, error } = useQuery({
    queryKey: ['multi-year-trend', props.baseYear],
    queryFn: () => api.get<MultiYearTrend>(`/report/multi-year-trend?baseYear=${props.baseYear}&depth=3`),
    retry: false,
  });
  if (error) return null;
  if (!data) return null;
  const years = data.years.filter((point) => point.comparable).map((point) => point.year);
  const skipped = data.years.filter((point) => !point.comparable);
  const rows = dimension === 'account' ? data.accounts : data.orgs;
  const trendCols = [
    /* 8 字符编码 ≈67px + 内边距:80px 下 monospace 末位被裁,取 100(方案二.B) */
    { title: '编码', dataIndex: 'code', width: 100, render: (v: string) => <span style={{ fontFamily: 'monospace' }}>{v}</span> },
    { title: '名称', dataIndex: 'name', width: 140, ellipsis: { showTitle: true } },
    ...years.map((year) => ({
      title: `${year}${dimension === 'account' ? '(万元)' : '(利润,万元)'}`,
      align: 'right' as const,
      render: (_: unknown, row: { values: Record<number, number>; yoy: Record<number, number | null> }) => {
        const value = row.values[year];
        const yoy = row.yoy[year];
        return (
          <span>
            {value === undefined ? <Typography.Text type="secondary">—</Typography.Text> : <MoneyText cents={value} hideUnit />}
            {yoy != null && <Tag style={{ marginLeft: 4 }} color={yoy >= 0 ? 'green' : 'red'}>{formatRate(yoy)}</Tag>}
          </span>
        );
      },
    })),
  ];
  return (
    <Card
      size="small"
      title={`年度节奏对比(同口径,基准年 ${data.baseYear})`}
      style={{ marginTop: 12 }}
      extra={<Segmented size="small" value={dimension} onChange={(value) => setDimension(value as 'account' | 'org')} options={[{ label: '科目维度', value: 'account' }, { label: '组织维度', value: 'org' }]} />}
    >
      <Space direction="vertical" size={6} style={{ width: '100%', marginBottom: 8 }}>
        {skipped.length > 0 && (
          <Alert type="warning" showIcon message={`不可比年份已如实跳过:${skipped.map((point) => `${point.year}(${point.reason ?? '无快照'})`).join('、')}`} />
        )}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          可比性:科目匹配 {data.comparability.matchedAccountCodes.length} / 新增 {data.comparability.addedAccountCodes.length} / 消失 {data.comparability.removedAccountCodes.length}
          ;组织匹配 {data.comparability.matchedOrgCodes.length} / 新增 {data.comparability.addedOrgCodes.length} / 消失 {data.comparability.removedOrgCodes.length}
          {data.comparability.removedOrgCodes.length > 0 && `(消失:${data.comparability.removedOrgCodes.join('、')})`}
        </Typography.Text>
      </Space>
      <Table size="small" rowKey="code" pagination={false} dataSource={rows} columns={trendCols} scroll={{ x: 'max-content', y: 320 }} />
    </Card>
  );
}

export default function History() {
  const { data, error, isLoading, refetch } = useQuery({ queryKey: ['historical'], queryFn: () => api.get<{ years: YearRow[]; notes: string[] }>('/report/historical') });

  /* 小澧助手页面登记(§7.2 history)：历年对比无筛选，ready 跟随报告加载;读取失败同样不算就绪。 */
  useAssistantPageContext({ pageKey: 'history', ready: !isLoading && !error, readyState: isLoading ? 'loading' : 'error', notReadyReason: error ? '历年对比读取失败' : '正在读取历年对比', scope: {}, view: {} });
  const { mode } = useThemeMode();

  /**
   * 收入-成本-费用堆叠柱(业务正数口径)+ 利润同比折线。
   * 注意单位不统一:三类 totals 是「分」且成本/费用为利润方向负值(故取反),
   * 而 yoyProfit 是「比率」——两者绝不能共用同一个格式化函数。
   */
  const structureOption = useMemo(() => {
    if (!data || data.years.length === 0) return {};
    const t = chartTheme(mode);
    const years = data.years.map((y) => String(y.year));
    /* 收入/成本/费用是类型语义,直接用 financeColor ——
       用系列色索引会随调色板调整而错位(旧板 index 4 是紫,新板已改为灰)。 */
    const fc = financeColor(mode);
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { data: ['收入', '成本', '费用', '利润同比'], top: 4 },
      grid: { top: 34, left: 70, right: 62, bottom: 26 },
      xAxis: { type: 'category', data: years },
      yAxis: [
        { type: 'value', axisLabel: { formatter: wanAxisLabel } },
        { type: 'value', axisLabel: { formatter: (v: number) => `${(v * 100).toFixed(0)}%` }, splitLine: { show: false } },
      ],
      series: [
        { name: '收入', type: 'bar', stack: 'structure', barMaxWidth: 28, data: data.years.map((y) => y.totals.incomeActual), itemStyle: { color: fc.income } },
        // 成本/费用在利润方向为负,取反后才是业务读数,才能与收入同向堆叠
        { name: '成本', type: 'bar', stack: 'structure', barMaxWidth: 28, data: data.years.map((y) => -y.totals.costActual), itemStyle: { color: fc.cost } },
        { name: '费用', type: 'bar', stack: 'structure', barMaxWidth: 28, data: data.years.map((y) => -y.totals.expenseActual), itemStyle: { color: fc.expense } },
        {
          name: '利润同比', type: 'line', yAxisIndex: 1, data: data.years.map((y) => y.yoyProfit),
          /* 3.4:同比是离散年度序列,不跨接缺失年 —— 跨接会画出不存在的趋势 */
          connectNulls: false, symbolSize: 7,
          /* 同比线是独立指标,不参与类型配色,取 accent 与三根柱子区分开 */
          lineStyle: { width: 2, color: t.accent }, itemStyle: { color: t.accent },
          tooltip: { valueFormatter: (v: number) => (v == null ? '不适用' : `${(v * 100).toFixed(2)}%`) },
          label: { show: true, formatter: (d: { value: number | null }) => (d.value == null ? '' : `${(d.value * 100).toFixed(0)}%`) },
        },
      ],
    };
  }, [data, mode]);

  const chartOption = useMemo(() => {
    if (!data) return {};
    const years = data.years.map((y) => String(y.year));
    return {
      tooltip: { trigger: 'axis', valueFormatter: (v: number) => `${centsToWan(v)} 万元` },
      legend: { data: ['利润预算', '利润实际'], top: 4 },
      grid: { top: 32, left: 80, right: 30 },
      xAxis: { type: 'category', data: years },
      yAxis: { type: 'value', axisLabel: { formatter: wanAxisLabel } },
      series: [
        { name: '利润预算', type: 'bar', barMaxWidth: 28, barGap: '20%', data: data.years.map((y) => y.totals.profitBudget) },
        { name: '利润实际', type: 'bar', barMaxWidth: 28, data: data.years.map((y) => y.totals.profitActual) },
      ],
    };
  }, [data]);

  const rateOption = useMemo(() => {
    if (!data || data.years.length === 0) return {};
    const years = data.years.map((y) => String(y.year));
    return {
      tooltip: { trigger: 'axis' },
      legend: { data: ['利润完成率', '预算准确率'], top: 4 },
      grid: { top: 32, left: 60, right: 30 },
      xAxis: { type: 'category', data: years },
      yAxis: { type: 'value', axisLabel: { formatter: (v: number) => `${(v * 100).toFixed(0)}%` } },
      series: [
        { name: '利润完成率', type: 'line', data: data.years.map((y) => y.rateProfit), label: { show: true, formatter: (d: { value: number | null }) => (d.value == null ? '' : `${(d.value * 100).toFixed(0)}%`) } },
        { name: '预算准确率', type: 'line', data: data.years.map((y) => y.accuracyProfit) },
      ],
    };
  }, [data]);

  /* 图表点击 → chart_point(period) 焦点(§8.4):三图 x 轴类目均为年度。 */
  const assistantRegistry = useOptionalAssistantRegistry();
  const focusTokenRef = useRef<symbol | null>(null);
  const handleYearClick = useCallback((point: ChartSemanticClick) => {
    if (!assistantRegistry || !point.name || !/^\d{4}$/.test(point.name)) return;
    if (focusTokenRef.current) assistantRegistry.clearFocus(focusTokenRef.current);
    focusTokenRef.current = assistantRegistry.setFocus(
      { kind: 'chart_point', seriesKey: 'history_year', dimensionType: 'period', period: point.name },
      `历年对比 · ${point.name} 年`,
    );
  }, [assistantRegistry]);
  useEffect(() => () => {
    if (focusTokenRef.current) assistantRegistry?.clearFocus(focusTokenRef.current);
  }, [assistantRegistry]);

  /* 空值给原因,不只显示 N/A:完成率/准确率受零预算限制,同比受相邻年度限制 */
  const naText = (reason: string) => <Typography.Text type="secondary" title={reason}>不适用</Typography.Text>;
  const cols = [
    /* 序号列:居中降色 tnum(方案《排版工具与数据组件》一.6),金额与完成率等信息列不动 */
    { title: '#', key: 'rank', width: 42, className: 'bd-col-rank', render: (_: unknown, __: YearRow, index: number) => index + 1 },
    { title: '年度', dataIndex: 'year', width: 62 },
    { title: '预算版本', dataIndex: 'budgetVersionName', width: 110, ellipsis: true, render: (v: string | null) => v ?? naText('该年度未设置当前采用的预算版本') },
    { title: '最终快照', dataIndex: 'finalSnapshotDate', width: 95, render: (v: string | null) => v ?? naText('该年度关闭时未指定最终快照') },
    { title: '收入预算', width: 88, align: 'right' as const, render: (_: unknown, y: YearRow) => <MoneyText cents={y.totals.incomeBudget} hideUnit /> },
    { title: '收入实际', width: 88, align: 'right' as const, render: (_: unknown, y: YearRow) => <MoneyText cents={y.totals.incomeActual} hideUnit /> },
    { title: '成本预算', width: 88, align: 'right' as const, render: (_: unknown, y: YearRow) => <MoneyText cents={-y.totals.costBudget} hideUnit /> },
    { title: '成本实际', width: 88, align: 'right' as const, render: (_: unknown, y: YearRow) => <MoneyText cents={-y.totals.costActual} hideUnit /> },
    { title: '费用预算', width: 85, align: 'right' as const, render: (_: unknown, y: YearRow) => <MoneyText cents={-y.totals.expenseBudget} hideUnit /> },
    { title: '费用实际', width: 85, align: 'right' as const, render: (_: unknown, y: YearRow) => <MoneyText cents={-y.totals.expenseActual} hideUnit /> },
    { title: '利润预算', width: 88, align: 'right' as const, render: (_: unknown, y: YearRow) => <MoneyText cents={y.totals.profitBudget} hideUnit /> },
    { title: '利润实际', width: 88, align: 'right' as const, render: (_: unknown, y: YearRow) => <MoneyText cents={y.totals.profitActual} hideUnit /> },
    { title: '利润差异', width: 88, align: 'right' as const, render: (_: unknown, y: YearRow) => <MoneyText cents={y.varianceProfit} hideUnit /> },
    { title: '收入完成率', width: 82, align: 'right' as const, render: (_: unknown, y: YearRow) => y.rateIncome == null ? naText('收入预算为 0 或为负，完成率不适用') : formatRate(y.rateIncome) },
    { title: '利润完成率', width: 82, align: 'right' as const, render: (_: unknown, y: YearRow) => y.rateProfit == null ? naText('利润预算为 0 或为负，完成率不适用') : formatRate(y.rateProfit) },
    { title: '利润同比', width: 75, align: 'right' as const, render: (_: unknown, y: YearRow) => y.yoyProfit == null ? naText('无相邻上一年度，或上年利润为 0，同比不适用') : formatRate(y.yoyProfit) },
    {
      title: '预算准确率', width: 96, align: 'right' as const, render: (_: unknown, y: YearRow) => (
        <span>{y.accuracyProfit == null ? naText('利润预算为 0，准确率不适用') : formatRate(y.accuracyProfit)}{y.accuracyProfit != null && y.accuracyProfit < 0.8 && <Tag color="orange" style={{ marginLeft: 4 }}>偏差大</Tag>}</span>
      ),
    },
  ];

  return (
    /* 无壳 + 无标题:顶栏已显示「历年对比」,Card title 是重复的第二遍 */
    <Card
      className="bd-root-card"
      extra={<Button icon={<i className="ri-download-2-line" aria-hidden />} onClick={() => download('/io/export/historical', '历年预实对比.xlsx')}>导出</Button>}
    >
      {/* 眉题:每页仅首个内容区块带,避免满屏编号 */}
      <div className="bd-eyebrow">历年对比</div>
      {/* 口径说明收敛为一行 + Tooltip:原文 79 字常驻首屏,把数据挤到折叠线以下。
          这是「看一次就够」的元信息,不该天天占着首屏。 */}
      <Space size={6} style={{ marginBottom: 12, alignItems: 'flex-start' }}>
        <span className="bd-quote">
          历史年度读取年度关闭时的最终快照,不按当前结构重算
        </span>
        <Tooltip title="历史年度一律读取年度关闭时指定的最终快照及其绑定树，不按当前组织/科目结构重算。金额单位万元；收入、成本、费用均按业务正数展示，利润与差异保留带符号利润方向。">
          <i className="ri-information-line" style={{ color: 'var(--bd-text-tertiary)', fontSize: 13, cursor: 'pointer', marginTop: 5 }} aria-hidden />
        </Tooltip>
      </Space>
      {error ? <Result status="error" title="历史数据加载失败" subTitle={error instanceof Error ? error.message : String(error)} extra={<Button onClick={() => void refetch()}>重试</Button>} /> : (!data || data.years.length === 0) ? (
        <Typography.Text type="secondary">暂无已冻结年度。请在「系统 → 年度关闭」中执行年度关闭。</Typography.Text>
      ) : (
        <>
          <Table size="small" rowKey="year" pagination={false} dataSource={data.years} columns={cols} scroll={{ x: 1200 }} />
          <Card size="small" title="历年预算与实际利润对比" style={{ marginTop: 16 }}>
            <EChart option={chartOption} onSemanticClick={handleYearClick} />
          </Card>
          {data.years.length > 0 && <Card size="small" title="收入 / 成本 / 费用构成与利润同比" style={{ marginTop: 12 }}>
            <EChart option={structureOption} onSemanticClick={handleYearClick} />
          </Card>}
          <Card size="small" title="历年利润完成率与预算准确率" style={{ marginTop: 12 }}>
            <EChart option={rateOption} onSemanticClick={handleYearClick} />
          </Card>
          <MultiYearTrendCard baseYear={data.years[data.years.length - 1].year} />
        </>
      )}
    </Card>
  );
}
