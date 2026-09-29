import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, Select, Space, Tag, Tooltip, Typography, Button, Alert, Descriptions, Statistic, Row, Col, TreeSelect, Result } from 'antd';
import { EnhancedTable as Table } from '../components/EnhancedTable';
import { api, download } from '../api/client';
import { centsToWan, formatRate } from '../utils/money';
import MoneyText from '../components/MoneyText';
import { escapeHtml } from '../utils/escapeHtml';
import { chartTheme, useThemeMode, statusColor } from '../theme';
import EChart from '../components/EChart';
import { useSheets, findSheet } from '../utils/sheets';
import { EvidenceDrawer, type EvidenceTarget } from '../components/EvidenceDrawer';
import { useSearchParams } from 'react-router-dom';
import { useAssistantPageContext } from '../assistant/contextHooks';
import { useOptionalAssistantRegistry } from '../assistant/AssistantContextRegistry';
import type { ChartSemanticClick } from '../components/EChart';

interface CompareResult {
  baseVersion: { id: number; year: number; name: string; status: string };
  targetVersion: { id: number; year: number; name: string; status: string };
  treeSame: boolean;
  addedOrgCodes: string[];
  removedOrgCodes: string[];
  addedAccountCodes: string[];
  removedAccountCodes: string[];
  leafChanges: { orgId: number; orgCode: string; accountId: number; accountCode: string; baseCents: number; targetCents: number; deltaCents: number; changeRate: number | null }[];
  totalBase: number;
  totalTarget: number;
  notes: string[];
  targetOrgRows: { id: number; parent_id: number | null; code: string; name: string }[];
  /** 科目树快照节点(带 type),用于按科目类型判定差异的有利方向 */
  targetAccountRows: { id: number; parent_id: number | null; code: string; name: string; type?: string }[];
}

interface SummaryResponse {
  totalsByAccountType: { income: number; cost: number; expense: number };
  metrics: { id: number; code: string; name: string }[];
  metricValues: Record<string, number>;
}

export default function VersionCompare() {
  const [params, setParams] = useSearchParams();
  const { mode } = useThemeMode();
  /* 利润方向变化的语义色:正负即有利/不利,色值走 STATUS_COLOR(暗色档自动换挡) */
  const deltaColor = (delta: number) => (delta >= 0 ? statusColor(mode).good : statusColor(mode).bad);
  const [evidenceTarget, setEvidenceTarget] = useState<EvidenceTarget | null>(null);
  const paramId = (key: string): number | undefined => {
    const value = Number(params.get(key));
    return Number.isInteger(value) && value > 0 ? value : undefined;
  };
  const base = paramId('base');
  const target = paramId('target');
  const orgScopeId = paramId('org') ?? null;
  const sheetKey = params.get('sheet') || 'all';
  const { sheets: dbSheets } = useSheets();
  const updateParams = (changes: Record<string, string | number | null | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value == null || (key === 'sheet' && value === 'all')) next.delete(key);
      else next.set(key, String(value));
    }
    setParams(next, { replace: true });
  };

  const { data: versions, error: versionsError, refetch: refetchVersions } = useQuery({ queryKey: ['versions'], queryFn: () => api.get<{ id: number; year: number; name: string; status: string; is_current: 0 | 1 }[]>('/versions') });

  /* 默认选中:目标版本=当前生效版本(或最新版本),基准版本=同年度前一个版本(或最早版本)。
     is_current 按年度各自生效,列表里可能先后出现多个年度的当前版本;
     第一个当前版本没有同年度伙伴时,退到能凑成同年度对比的版本,否则基准永远解析不出来。 */
  useEffect(() => {
    if (base != null && target != null) return;
    if (!versions || versions.length < 2) return;
    const firstCurrent = versions.find((v) => v.is_current === 1);
    const pairOf = (v: { id: number; year: number } | undefined) =>
      v ? versions.find((row) => row.year === v.year && row.id !== v.id) : undefined;
    const tgt = (firstCurrent && pairOf(firstCurrent) ? firstCurrent : undefined)
      ?? versions.find((v) => pairOf(v))
      ?? firstCurrent
      ?? versions[versions.length - 1];
    if (!tgt) return;
    const b = pairOf(tgt);
    let changed = false;
    const next = new URLSearchParams(params);
    if (target == null) { next.set('target', String(tgt.id)); changed = true; }
    if (base == null && b) { next.set('base', String(b.id)); changed = true; }
    if (changed) setParams(next, { replace: true });
  }, [versions, base, target, params, setParams]);
  /* 小澧助手页面登记(§7.2 version_compare)：基准/目标版本、组织与表格筛选。 */
  useAssistantPageContext({
    pageKey: 'version_compare',
    ready: base != null && target != null,
    notReadyReason: '正在解析对比版本默认值',
    readyState: 'loading',
    scope: { baseVersionId: base, compareVersionId: target, orgScopeId: orgScopeId ?? undefined },
    view: { sheetKey },
  });

  const { data: cmp, error: compareError } = useQuery({
    queryKey: ['version-compare', base, target],
    enabled: !!base && !!target,
    queryFn: () => api.get<CompareResult>(`/report/version-compare?base=${base}&target=${target}`),
  });

  /* 龙卷风图点击 → chart_point(account) 焦点(§8.4):类目「code name」经 leafChanges 反查 accountId。 */
  const assistantRegistry = useOptionalAssistantRegistry();
  const focusTokenRef = useRef<symbol | null>(null);
  const handleTornadoClick = useCallback((point: ChartSemanticClick) => {
    if (!assistantRegistry || !cmp || !point.name) return;
    const code = point.name.split(' ')[0];
    const change = cmp.leafChanges.find((row) => row.accountCode === code);
    if (!change) return;
    if (focusTokenRef.current) assistantRegistry.clearFocus(focusTokenRef.current);
    focusTokenRef.current = assistantRegistry.setFocus(
      { kind: 'chart_point', seriesKey: 'tornado', dimensionType: 'account', dimensionId: change.accountId },
      `差异龙卷风 · ${point.name}`,
    );
  }, [assistantRegistry, cmp]);
  useEffect(() => () => {
    if (focusTokenRef.current) assistantRegistry?.clearFocus(focusTokenRef.current);
  }, [assistantRegistry]);
  /* 两版本指标(利润表计算行)对比:全组织口径 */
  const { data: baseSummary } = useQuery({
    queryKey: ['version-summary', base],
    enabled: !!base,
    queryFn: () => api.get<SummaryResponse>(`/versions/${base}/summary`),
  });
  const { data: targetSummary } = useQuery({
    queryKey: ['version-summary', target],
    enabled: !!target,
    queryFn: () => api.get<SummaryResponse>(`/versions/${target}/summary`),
  });
  const metricRows = useMemo(() => {
    if (!baseSummary || !targetSummary) return [];
    return [...baseSummary.metrics]
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((m) => {
        const b = baseSummary.metricValues[String(m.id)] ?? 0;
        const t = targetSummary.metricValues[String(m.id)] ?? 0;
        return { key: m.code, code: m.code, name: m.name, base: b, target: t, delta: t - b };
      });
  }, [baseSummary, targetSummary]);

  const versionById = useMemo(() => new Map((versions ?? []).map((v) => [v.id, v])), [versions]);
  const baseOptions = useMemo(() => (versions ?? []).filter((v) => target == null || v.year === versionById.get(target)?.year).map((v) => ({ value: v.id, label: `${v.year} · ${v.name} (${v.status})` })), [versions, target, versionById]);
  const targetOptions = useMemo(() => (versions ?? []).filter((v) => base == null || v.year === versionById.get(base)?.year).map((v) => ({ value: v.id, label: `${v.year} · ${v.name} (${v.status})` })), [versions, base, versionById]);

  const orgTreeData = useMemo(() => {
    interface TreeItem { value: number; title: string; children: TreeItem[] }
    const rows = cmp?.targetOrgRows ?? [];
    const children = new Map<number | null, typeof rows>();
    rows.forEach((row) => children.set(row.parent_id, [...(children.get(row.parent_id) ?? []), row]));
    const build = (parentId: number | null): TreeItem[] => (children.get(parentId) ?? []).map((n) => ({ value: n.id, title: `${n.code} ${n.name}`, children: build(n.id) }));
    return build(null);
  }, [cmp]);

  useEffect(() => {
    if (orgScopeId != null && cmp && !cmp.targetOrgRows.some((row) => row.id === orgScopeId)) {
      const next = new URLSearchParams(params);
      next.delete('org');
      setParams(next, { replace: true });
    }
  }, [cmp, orgScopeId, params, setParams]);

  /** 组织子树编码集合(选中范围时过滤明细行) */
  const orgScopeCodes = useMemo(() => {
    if (orgScopeId == null) return null;
    const rows = cmp?.targetOrgRows ?? [];
    const children = new Map<number, number[]>();
    rows.forEach((r) => { const p = r.parent_id; if (p != null) children.set(p, [...(children.get(p) ?? []), r.id]); });
    const codes = new Set<string>();
    const walk = (id: number) => { const n = rows.find((r) => r.id === id); if (n) codes.add(n.code); (children.get(id) ?? []).forEach(walk); };
    walk(orgScopeId);
    return codes;
  }, [orgScopeId, cmp]);

  /** 预设表科目编码集合(差异明细按全子树,不折叠) */
  const sheetAccountCodes = useMemo(() => {
    if (sheetKey === 'all') return null;
    const sheet = findSheet(sheetKey, dbSheets);
    if (!sheet || sheet.roots.length === 0) return null;
    const rows = cmp?.targetAccountRows ?? [];
    const children = new Map<number, number[]>();
    rows.forEach((r) => { const p = r.parent_id; if (p != null) children.set(p, [...(children.get(p) ?? []), r.id]); });
    const codes = new Set<string>();
    const walk = (id: number) => { const n = rows.find((r) => r.id === id); if (n) codes.add(n.code); (children.get(id) ?? []).forEach(walk); };
    for (const code of sheet.roots) {
      const root = rows.find((r) => r.code === code);
      if (root) walk(root.id);
    }
    return codes;
  }, [sheetKey, cmp, dbSheets]);

  const filteredChanges = useMemo(() => {
    if (!cmp) return [];
    return cmp.leafChanges.filter((r) =>
      (orgScopeCodes == null || orgScopeCodes.has(r.orgCode)) && (sheetAccountCodes == null || sheetAccountCodes.has(r.accountCode)));
  }, [cmp, orgScopeCodes, sheetAccountCodes]);

  /**
   * 差异龙卷风:按科目聚合(同一科目跨组织的差异相加),取绝对额 Top N 左右分叉。
   * leafChanges 已由后端按 |变化额| 降序,这里聚合后重排即可。
   */
  const tornado = useMemo(() => {
    if (!cmp) return null;
    const byAccount = new Map<string, { code: string; name: string; delta: number; type: string }>();
    const typeOf = new Map((cmp.targetAccountRows ?? []).map((row) => [row.code, row.type ?? '']));
    const nameOf = new Map((cmp.targetAccountRows ?? []).map((row) => [row.code, row.name]));
    for (const change of filteredChanges) {
      const entry = byAccount.get(change.accountCode) ?? {
        code: change.accountCode,
        name: nameOf.get(change.accountCode) ?? change.accountCode,
        delta: 0,
        type: typeOf.get(change.accountCode) ?? '',
      };
      entry.delta += change.deltaCents;
      byAccount.set(change.accountCode, entry);
    }
    const rows = [...byAccount.values()]
      .filter((row) => row.delta !== 0)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    if (rows.length === 0) return null;
    return { rows: rows.slice(0, 15), total: rows.length };
  }, [cmp, filteredChanges]);

  const tornadoOption = useMemo(() => {
    if (!tornado) return {};
    const t = chartTheme(mode);
    // ECharts 类目轴自下而上绘制,倒序后最大的差异落在顶部
    const rows = [...tornado.rows].reverse();
    /**
     * 利润方向下「正差异」的含义随科目类型反转:
     * 收入增加为有利(绿),成本费用增加为不利(红)。
     */
    /* 有利/不利是状态语义,取 STATUS_COLOR:
       系列色已避开红绿,这里却要靠红绿让「变好还是变坏」一眼可读。 */
    const status = statusColor(mode);
    const colorOf = (row: { delta: number; type: string }) => {
      const good = row.type === 'cost' || row.type === 'expense' ? row.delta < 0 : row.delta > 0;
      return good ? status.good : status.bad;
    };
    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: { name: string; value: number }[]) => {
          const row = tornado.rows.find((r) => `${r.code} ${r.name}` === params[0]?.name);
          if (!row) return '';
          const direction = row.type === 'cost' || row.type === 'expense' ? '（成本费用口径：减少为有利）' : '（收入口径：增加为有利）';
          return `${escapeHtml(row.code)} ${escapeHtml(row.name)}<br/>变化额 ${centsToWan(row.delta)} 万元${direction}`;
        },
      },
      grid: { top: 16, left: 8, right: 24, bottom: 20, containLabel: true },
      // 数据已是万元(row.delta / 1e6),用千分位格式化;不能用 wanAxisLabel,它会再除一次 1e6
      xAxis: { type: 'value', axisLabel: { formatter: (v: number) => v.toLocaleString('zh-CN', { maximumFractionDigits: 0 }) } },
      yAxis: { type: 'category', data: rows.map((row) => `${row.code} ${row.name}`), axisTick: { show: false } },
      series: [{
        type: 'bar',
        barWidth: '62%',
        data: rows.map((row) => ({
          value: row.delta / 1_000_000,
          itemStyle: { color: colorOf(row), borderRadius: 3 },
          label: { position: row.delta >= 0 ? 'right' : 'left' },
        })),
        label: {
          show: true,
          formatter: (p: { value: number }) => `${p.value > 0 ? '+' : ''}${p.value.toFixed(2)}`,
          fontSize: 12,
        },
      }],
    };
  }, [tornado, mode]);

  return (
    <>
    {/* 无壳 + 无标题:顶栏已显示「版本对比」,Card title 是重复的第二遍 */}
    <Card
      className="bd-root-card"
      extra={<Button icon={<i className="ri-download-2-line" aria-hidden />} disabled={!cmp} title={cmp ? '导出当前两版本的对比明细' : '请先选择基准版本与对比版本'} onClick={() => void download(`/io/export/version-compare?base=${base}&target=${target}`, '版本对比.xlsx')}>导出</Button>}
    >
      {versionsError ? <Result status="error" title="版本列表加载失败" subTitle={versionsError instanceof Error ? versionsError.message : String(versionsError)} extra={<Button onClick={() => void refetchVersions()}>重试</Button>} /> : <Space wrap style={{ marginBottom: 16 }}>
        <Select showSearch optionFilterProp="label" placeholder="基准版本" style={{ width: 240 }} value={base} onChange={(value) => updateParams({ base: value, target: target != null && versionById.get(target)?.year !== versionById.get(value)?.year ? null : target })} options={baseOptions} />
        <Select showSearch optionFilterProp="label" placeholder="目标版本" style={{ width: 240 }} value={target} onChange={(value) => updateParams({ target: value, base: base != null && versionById.get(base)?.year !== versionById.get(value)?.year ? null : base })} options={targetOptions} />
        <TreeSelect
          style={{ width: 210 }}
          treeData={orgTreeData}
          value={orgScopeId ?? undefined}
          allowClear
          treeDefaultExpandAll
          placeholder="组织范围(默认全部)"
          onChange={(v) => updateParams({ org: (v as number | null) ?? null })}
        />
        <Select style={{ width: 150 }} value={sheetKey} onChange={(value) => updateParams({ sheet: value })} options={[{ value: 'all', label: '全部科目' }, ...dbSheets.map((s) => ({ value: s.key, label: s.name }))]} />
      </Space>}

      {!cmp && <Alert type="info" showIcon message="选择同年度的两个版本进行比较(基准 → 目标)" />}
      {compareError && <Alert type="error" showIcon style={{ marginBottom: 12 }} message="版本对比失败" description={compareError instanceof Error ? compareError.message : String(compareError)} />}
      {cmp && (
        <>
          {!cmp.treeSame && (
            <Alert
              type="warning" showIcon style={{ marginBottom: 12 }}
              message="两版本树快照不一致,结构口径不同:按 ID 对齐,新增组合原版本按零处理,汇总用目标版本树。"
            />
          )}
          <Row gutter={[16, 16]} style={{ marginBottom: 12 }}>
            <Col xs={24} sm={12} lg={6}><Card size="small"><Statistic title={`基准总额(${cmp.baseVersion.name})`} value={centsToWan(cmp.totalBase)} suffix="万元" /></Card></Col>
            <Col xs={24} sm={12} lg={6}><Card size="small"><Statistic title={`目标总额(${cmp.targetVersion.name})`} value={centsToWan(cmp.totalTarget)} suffix="万元" /></Card></Col>
            <Col xs={24} sm={12} lg={6}><Card size="small"><Statistic title="变化额" value={centsToWan(cmp.totalTarget - cmp.totalBase)} suffix="万元" valueStyle={{ color: deltaColor(cmp.totalTarget - cmp.totalBase) }} /></Card></Col>
            <Col xs={24} sm={12} lg={6}>
              <Card size="small">
                <Descriptions size="small" column={1}>
                  <Descriptions.Item label="新增组织">{cmp.addedOrgCodes.length ? cmp.addedOrgCodes.join(', ') : '无'}</Descriptions.Item>
                  <Descriptions.Item label="移除组织">{cmp.removedOrgCodes.length ? cmp.removedOrgCodes.join(', ') : '无'}</Descriptions.Item>
                </Descriptions>
              </Card>
            </Col>
          </Row>
          {metricRows.length > 0 && (
            <Card size="small" title="利润表指标对比(计算行,全组织口径,利润方向)" style={{ marginBottom: 12 }}>
              <Table
                size="small"
                rowKey="key"
                pagination={false}
                dataSource={metricRows}
                columns={[
                  { title: '指标编码', dataIndex: 'code', width: 100 },
                  { title: '指标名称', dataIndex: 'name', width: 150 },
                  { title: `基准(万元,${cmp.baseVersion.name})`, dataIndex: 'base', align: 'right' as const, render: (v: number) => <MoneyText cents={v} hideUnit /> },
                  { title: `目标(万元,${cmp.targetVersion.name})`, dataIndex: 'target', align: 'right' as const, render: (v: number) => <MoneyText cents={v} hideUnit /> },
                  { title: '变化额(万元)', dataIndex: 'delta', align: 'right' as const, render: (v: number) => <MoneyText cents={v} hideUnit tone={v >= 0 ? 'good' : 'bad'} /> },
                ]}
              />
            </Card>
          )}
          {tornado && (
            <Card
              size="small"
              title="差异龙卷风（按科目聚合）"
              extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {tornado.total > tornado.rows.length ? `列出前 ${tornado.rows.length} / 共 ${tornado.total} 个科目` : `共 ${tornado.total} 个科目`}
              </Typography.Text>}
              style={{ marginBottom: 12 }}
            >
              <EChart option={tornadoOption} height={Math.max(280, Math.min(tornado.rows.length, 15) * 30 + 70)} onSemanticClick={handleTornadoClick} />
            </Card>
          )}
          <Card size="small" title={`叶子明细变化(按变化额排序${orgScopeId != null || sheetKey !== 'all' ? ',已按组织/表筛选;顶部合计为全口径' : ''})`} style={{ marginBottom: 12 }}>
            <Table
              size="small"
              rowKey={(r) => `${r.orgId}:${r.accountId}`}
              pagination={{ pageSize: 20 }}
              dataSource={filteredChanges}
                columns={[
                  /* 编码列按 12 字符预留 ~115px:科目码加深后不压线(方案二.B) */
                  { title: '组织编码', dataIndex: 'orgCode', width: 115, ellipsis: { showTitle: true } },
                  { title: '科目编码', dataIndex: 'accountCode', width: 115, ellipsis: { showTitle: true } },
                { title: `基准(万元,${cmp.baseVersion.name})`, dataIndex: 'baseCents', align: 'right' as const, render: (v: number) => <MoneyText cents={v} hideUnit /> },
                { title: `目标(万元,${cmp.targetVersion.name})`, dataIndex: 'targetCents', align: 'right' as const, render: (v: number) => <MoneyText cents={v} hideUnit /> },
                { title: '变化额(万元,利润方向)', dataIndex: 'deltaCents', align: 'right' as const, render: (v: number) => <MoneyText cents={v} hideUnit tone={v >= 0 ? 'good' : 'bad'} /> },
                { title: '变化率', dataIndex: 'changeRate', align: 'right' as const, render: (v: number | null) => (v == null ? <Tooltip title="基准版本该单元格为 0，无法计算变化率"><Tag>不适用</Tag></Tooltip> : formatRate(v)) },
                { title: '来源', width: 120, render: (_: unknown, r) => <Space size={0}><Button type="link" size="small" onClick={() => setEvidenceTarget({ type: 'budget', sourceId: base!, accountId: r.accountId, orgId: r.orgId })}>基准</Button><Button type="link" size="small" onClick={() => setEvidenceTarget({ type: 'budget', sourceId: target!, accountId: r.accountId, orgId: r.orgId })}>目标</Button></Space> },
              ]}
            />
          </Card>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{cmp.notes.join(';')}</Typography.Text>
        </>
      )}
    </Card>
    <EvidenceDrawer target={evidenceTarget} onTargetChange={setEvidenceTarget} />
    </>
  );
}
