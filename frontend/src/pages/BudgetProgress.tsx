import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Progress, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { QueryErrorResult } from '../components/QueryErrorResult';
import { shortTime } from '../utils/relativeTime';
import { useAssistantPageContext } from '../assistant/contextHooks';
import { useUrlScopeSync } from '../hooks/useUrlScopeSync';
import type { ScopeIssue } from '../utils/workspaceScope';

interface ProgressRow {
  orgId: number;
  orgCode: string;
  orgName: string;
  parentPath: string;
  filled: number;
  total: number;
  percent: number;
  blocking: number;
  warning: number;
  lastEditAt: string | null;
}

interface ProgressReport {
  versionId: number;
  rows: ProgressRow[];
  summary: { orgCount: number; avgPercent: number; notStarted: number; inProgress: number; completed: number; notApplicable?: number };
}

/**
 * 编制进度总览:覆盖度判定与「定稿体检」完全同源(后端 computeRequiredCells),
 * 树口径取版本绑定的不可变快照;点击行跳转 BudgetEdit 并带 ?orgId= 定位。
 */
export default function BudgetProgress() {
  const navigate = useNavigate();
  const { data: versions, error: versionsError, refetch: refetchVersions } = useQuery({
    queryKey: ['versions'],
    queryFn: () => api.get<{ id: number; year: number; name: string; status: string; is_current: 0 | 1 }[]>('/versions'),
  });
  const [versionId, setVersionId] = useState<number | undefined>();
  const effectiveVersionId = versionId ?? versions?.find((v) => v.is_current === 1)?.id ?? versions?.[0]?.id;
  const effectiveYear = versions?.find((v) => v.id === effectiveVersionId)?.year;

  /* URL 范围契约(UX-02):?version= / ?year= 进 URL,刷新与书签恢复同一版本;
     失效版本(不存在/已删除)给出可见说明并回落默认版本,不静默换成另一个目标 ——
     进度页虽只读,但「点组织行进编制」会把该版本带进编辑页。 */
  const [scopeIssues, setScopeIssues] = useState<ScopeIssue[]>([]);
  /* 待校验的 URL 范围是 state 而不是 ref:页内前进/后退换 URL 时也要重新走归属校验 */
  const [urlScope, setUrlScope] = useState<{ year?: number; version?: number }>({});
  useUrlScopeSync('budget_progress', { year: effectiveYear, budgetVersionId: effectiveVersionId }, (parsed) => {
    setUrlScope({ year: parsed.scope.year, version: parsed.scope.budgetVersionId });
    if (parsed.issues.length > 0) {
      setScopeIssues((prev) => [...prev, ...parsed.issues.filter((issue) => !prev.some((p) => p.key === issue.key && p.raw === issue.raw))]);
    }
  });

  /* 归属校验:URL 版本必须真实存在;仅给年度时落到该年度当前生效版本 */
  useEffect(() => {
    if (!versions) return;
    const { year: urlYear, version: urlVersion } = urlScope;
    if (urlVersion != null) {
      const found = versions.find((v) => v.id === urlVersion);
      if (found) {
        setVersionId((prev) => (prev === urlVersion ? prev : urlVersion));
      } else {
        setScopeIssues((prev) => (prev.some((p) => p.key === 'version' && p.raw === String(urlVersion)) ? prev : [...prev, {
          key: 'version', field: 'budgetVersionId', raw: String(urlVersion), reason: 'not_found',
          detail: `链接中的预算版本 ${urlVersion} 不存在或已删除,已显示默认版本`,
        }]));
      }
      setUrlScope((prev) => ({ ...prev, version: undefined }));
      return;
    }
    if (urlYear != null) {
      const ofYear = versions.filter((v) => v.year === urlYear);
      if (ofYear.length > 0) {
        const pick = ofYear.find((v) => v.is_current === 1) ?? ofYear[0];
        setVersionId((prev) => (prev === pick.id ? prev : pick.id));
      } else {
        setScopeIssues((prev) => (prev.some((p) => p.key === 'year' && p.raw === String(urlYear)) ? prev : [...prev, {
          key: 'year', field: 'year', raw: String(urlYear), reason: 'not_found',
          detail: `链接中的 ${urlYear} 年没有任何预算或预测版本,已显示默认版本`,
        }]));
      }
      setUrlScope((prev) => ({ ...prev, year: undefined }));
    }
  }, [versions, urlScope]);

  /* 小澧助手页面登记(§7.2 budget_progress)：年度/预算版本/填报状态。 */
  useAssistantPageContext({
    pageKey: 'budget_progress',
    ready: effectiveVersionId != null,
    notReadyReason: '正在读取预算版本列表',
    readyState: 'loading',
    scope: {
      budgetVersionId: effectiveVersionId,
      year: versions?.find((v) => v.id === effectiveVersionId)?.year,
    },
    view: {},
  });

  const { data, isLoading, error: progressError, refetch: refetchProgress } = useQuery({
    queryKey: ['budget-progress', effectiveVersionId],
    queryFn: () => api.get<ProgressReport>(`/versions/${effectiveVersionId}/progress`),
    enabled: effectiveVersionId != null,
  });

  const summary = data?.summary;

  /**
   * 定位首个待处理项(UX-03):阻断优先,其次未填完;「无科目」组织(total=0)不算待处理。
   * 沿用既有按组织定位编制页的契约(/budget/:id?orgId=)。
   */
  const firstPending = useMemo(() => {
    const rows = data?.rows ?? [];
    return rows.find((row) => row.blocking > 0) ?? rows.find((row) => row.total > 0 && row.filled < row.total) ?? null;
  }, [data]);
  const columns = useMemo(() => [
    { title: '组织编码', dataIndex: 'orgCode', width: 120 },
    {
      title: '组织名称',
      dataIndex: 'orgName',
      render: (name: string, row: ProgressRow) => (
        <ButtonLink onClick={() => navigate(`/budget/${effectiveVersionId}?orgId=${row.orgId}`)}>{name}</ButtonLink>
      ),
    },
    { title: '父级路径', dataIndex: 'parentPath', render: (v: string) => v || '—' },
    {
      title: '覆盖度',
      dataIndex: 'percent',
      width: 200,
      sorter: (a: ProgressRow, b: ProgressRow) => a.percent - b.percent,
      render: (percent: number, row: ProgressRow) => (
        <Space size={8}>
          <Progress percent={percent} size="small" style={{ width: 120 }} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{row.filled}/{row.total}</Typography.Text>
        </Space>
      ),
    },
    { title: '阻断', dataIndex: 'blocking', width: 80, render: (v: number) => (v > 0 ? <Tag color="red">{v}</Tag> : '0') },
    { title: '提醒', dataIndex: 'warning', width: 80, render: (v: number) => (v > 0 ? <Tag color="orange">{v}</Tag> : '0') },
    { title: '最后编辑', dataIndex: 'lastEditAt', width: 155, render: (v: string | null) => (v ? shortTime(v) : '—') },
  ], [effectiveVersionId, navigate]);

  return (
    <Card className="bd-root-card">
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
      <Space style={{ marginBottom: 12 }} wrap>
        <Typography.Text strong>预算版本</Typography.Text>
        <Select
          showSearch
          optionFilterProp="label"
          style={{ width: 260 }}
          value={effectiveVersionId}
          onChange={setVersionId}
          options={(versions ?? []).map((v) => ({ value: v.id, label: `${v.year} · ${v.name}${v.status === 'locked' ? ' (已定稿)' : ''}${v.is_current ? ' (当前)' : ''}` }))}
        />
        <Tooltip title={data == null ? '进度数据加载中' : firstPending ? `进入「${firstPending.orgName}」的编制页定位` : '各组织均无待处理项'}>
          {/* disabled 元素不触发鼠标事件,Tooltip 需要包一层 span 才能展示原因 */}
          <span>
            <Button
              disabled={!firstPending}
              onClick={() => { if (firstPending) navigate(`/budget/${effectiveVersionId}?orgId=${firstPending.orgId}`); }}
            >定位首个待处理项</Button>
          </span>
        </Tooltip>
        {summary && (
          <Space size={12}>
            <Tag>组织 {summary.orgCount}</Tag>
            <Tag color="blue">平均覆盖 {summary.avgPercent}%</Tag>
            <Tag>未开始 {summary.notStarted}</Tag>
            <Tag color="orange">进行中 {summary.inProgress}</Tag>
            <Tag color="green">已完成 {summary.completed}</Tag>
            {(summary.notApplicable ?? 0) > 0 && <Tag color="default">无科目 {summary.notApplicable}</Tag>}
          </Space>
        )}
      </Space>
      {(versionsError || progressError) ? (
        /* 失败优先于空表:错误状态下空表会被误读为「各组织均未开始」 */
        <QueryErrorResult
          title={versionsError ? '预算版本列表加载失败' : '编制进度加载失败'}
          error={versionsError ?? progressError}
          refetch={() => { if (versionsError) void refetchVersions(); else void refetchProgress(); }}
        />
      ) : (
      <Table<ProgressRow>
        rowKey="orgId"
        size="small"
        loading={isLoading}
        dataSource={data?.rows ?? []}
        columns={columns}
        pagination={false}
        onRow={(row) => ({
          style: { cursor: 'pointer' },
          onClick: () => navigate(`/budget/${effectiveVersionId}?orgId=${row.orgId}`),
        })}
      />
      )}
    </Card>
  );
}

function ButtonLink(props: { onClick: () => void; children: React.ReactNode }) {
  return (
    <a onClick={(e) => { e.stopPropagation(); props.onClick(); }}>{props.children}</a>
  );
}
