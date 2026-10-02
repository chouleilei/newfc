import { useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts';
import { chartTheme, useThemeMode, withAlpha } from '../theme';

/**
 * 柱状系列统一「科技感」修饰:纵向渐变 + 顶部圆角。
 * 只在业务 option 未显式指定 itemStyle.color 时套用,避免覆盖有语义的配色
 * (如超支红/达标绿),否则会把业务信息抹平。
 */
function decorateBars(series: unknown, colors: string[]): unknown {
  if (!Array.isArray(series)) return series;
  return series.map((raw, i) => {
    const s = raw as Record<string, unknown>;
    if (s.type !== 'bar') return s;
    const itemStyle = (s.itemStyle ?? {}) as Record<string, unknown>;
    if (itemStyle.color !== undefined) return s;
    const base = colors[i % colors.length];
    return {
      ...s,
      itemStyle: {
        borderRadius: [4, 4, 0, 0],
        ...itemStyle,
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: base },
            { offset: 1, color: withAlpha(base, 0.45) },
          ],
        },
      },
    };
  });
}

/**
 * 图表语义点击(现行 specs/ai.md 页面上下文契约§8.4)：
 * 只把 ECharts data 的语义维度(seriesKey/name/dataIndex)交给页面，
 * 由页面自行翻译成 chart_point 焦点；像素坐标和展示 value 不进入助手上下文。
 */
export interface ChartSemanticClick {
  seriesKey: string;
  /** 维度名(组织/科目/期间等) */
  name: string;
  dataIndex: number;
  /** 节点原始 data(treemap 等场景自带维度 id,页面可直取,免按名称反查) */
  data?: unknown;
}

export default function EChart({ option, height = 360, onSemanticClick }: { option: Record<string, unknown>; height?: number; onSemanticClick?: (point: ChartSemanticClick) => void }) {
  const ref = useRef<HTMLDivElement>(null); const chartRef = useRef<echarts.ECharts | null>(null); const { mode } = useThemeMode();
  const clickRef = useRef(onSemanticClick);
  clickRef.current = onSemanticClick;
  /* tooltip 边框接 chartTheme 的 axisLine,亮暗自换挡(原为硬编码亮值)。
     不加 backdrop-filter:tooltip 随鼠标高频重绘,毛玻璃是逐帧合成开销(方案 3.4)。 */
  const baseOption = useMemo(() => { const t = chartTheme(mode); return { color: t.colors, backgroundColor: 'transparent', textStyle: { color: t.text }, tooltip: { backgroundColor: t.tooltipBg, textStyle: { color: t.tooltipText }, borderColor: t.axisLine } }; }, [mode]);
  useEffect(() => { const el = ref.current; if (!el) return; const chart = echarts.init(el, mode === 'dark' ? 'dark' : undefined); chartRef.current = chart; const ro = new ResizeObserver(() => chart.resize()); ro.observe(el); return () => { ro.disconnect(); chart.dispose(); chartRef.current = null; }; }, [mode]);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const handler = (params: unknown) => {
      const p = params as { seriesName?: string; name?: string; dataIndex?: number; data?: unknown };
      if (!clickRef.current || p == null || typeof p.dataIndex !== 'number') return;
      clickRef.current({ seriesKey: String(p.seriesName ?? ''), name: String(p.name ?? ''), dataIndex: p.dataIndex, data: p.data });
    };
    chart.on('click', handler);
    return () => { chart.off('click', handler); };
    /* handler 经 clickRef 读最新 onSemanticClick,不依赖 option;
       去掉 option 依赖,避免每次数据/主题变化都无意义地解绑再重绑。 */
  }, [mode]);
  useEffect(() => {
    const t = chartTheme(mode);
    const axisStyle = { axisLabel: { color: t.text }, axisLine: { lineStyle: { color: t.axisLine } }, axisTick: { lineStyle: { color: t.axisLine } }, splitLine: { lineStyle: { color: t.splitLine } } };
    const styleAxis = (axis: unknown) => Array.isArray(axis)
      ? axis.map(item => ({ ...axisStyle, ...(item as Record<string, unknown>), axisLabel: { ...axisStyle.axisLabel, ...((item as Record<string, unknown>).axisLabel as object ?? {}) }, axisLine: { ...axisStyle.axisLine, ...((item as Record<string, unknown>).axisLine as object ?? {}) }, splitLine: { ...axisStyle.splitLine, ...((item as Record<string, unknown>).splitLine as object ?? {}) } }))
      : { ...axisStyle, ...(axis as Record<string, unknown> ?? {}), axisLabel: { ...axisStyle.axisLabel, ...((axis as Record<string, unknown> | undefined)?.axisLabel as object ?? {}) }, axisLine: { ...axisStyle.axisLine, ...((axis as Record<string, unknown> | undefined)?.axisLine as object ?? {}) }, splitLine: { ...axisStyle.splitLine, ...((axis as Record<string, unknown> | undefined)?.splitLine as object ?? {}) } };
    const themed = { ...option } as Record<string, unknown>;
    if (themed.xAxis) themed.xAxis = styleAxis(themed.xAxis);
    if (themed.yAxis) themed.yAxis = styleAxis(themed.yAxis);
    if (themed.series) themed.series = decorateBars(themed.series, t.colors);
    chartRef.current?.setOption({ ...baseOption, ...themed }, { notMerge: true });
  }, [baseOption, option, mode]);
  return <div ref={ref} style={{ width: '100%', height }} />;
}
