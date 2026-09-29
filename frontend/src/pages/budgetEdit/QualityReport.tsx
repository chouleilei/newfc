/**
 * 定稿质量门禁展示组件(AI 功能增强计划 §四.阶段一)。
 *
 * - QualityIssueList:问题逐条渲染 + 静态帮助文案(为什么是问题/影响/处理) + 定位;
 * - QualityAdviceBlock:处理顺序与最小修复路径建议(只读,标记来源;
 *   模型未配置或守卫失败时后端回退确定性模板稿,前端照样展示);
 * - QualityReportContent:覆盖度 + 归并统计 + 全部问题 + 建议,供定稿体检与定稿确认复用。
 */
import { useQuery } from '@tanstack/react-query';
import { Button, Progress, Spin, Tag, Typography } from 'antd';
import { api } from '../../api/client';
import { Markdown } from '../../components/assistant/Markdown';

export interface QualityIssue {
  code: string;
  severity: 'blocking' | 'warning';
  message: string;
  row?: number;
  orgId?: number;
  accountId?: number;
  ruleId?: number;
}

export interface QualityGroup {
  code: string;
  severity: 'blocking' | 'warning';
  count: number;
  orgCount: number;
  accountCount: number;
  summary: string;
}

export interface QualityHelpEntry { why: string; impact: string; fix: string }

export interface QualityReportData {
  canFinalize: boolean;
  blockingCount: number;
  warningCount: number;
  coverage: { filled: number; total: number; percent: number };
  issues: QualityIssue[];
  groups?: QualityGroup[];
  help?: Record<string, QualityHelpEntry>;
}

interface QualityAdviceResponse {
  advice: string;
  source: 'template' | 'model';
  model: string;
  cached: boolean;
  canFinalize: boolean;
  blockingCount: number;
  warningCount: number;
}

export function QualityIssueList(props: {
  issues: QualityIssue[];
  help?: Record<string, QualityHelpEntry>;
  onLocate?: (orgId: number, accountId: number) => void;
}) {
  if (props.issues.length === 0) {
    return <Typography.Text type="success">检查通过，可以定稿。</Typography.Text>;
  }
  return (
    <div style={{ maxHeight: 320, overflow: 'auto' }}>
      {props.issues.map((issue, index) => {
        const help = props.help?.[issue.code];
        return (
          <div key={`${issue.code}:${index}`} style={{ marginBottom: 8 }}>
            <Tag color={issue.severity === 'blocking' ? 'red' : 'orange'}>{issue.severity === 'blocking' ? '阻塞' : '提醒'}</Tag>
            <Tag>{issue.code}</Tag>
            {issue.message}
            {issue.orgId != null && issue.accountId != null && props.onLocate && (
              <Button size="small" type="link" onClick={() => props.onLocate!(issue.orgId!, issue.accountId!)}>定位</Button>
            )}
            {help && (
              <div style={{ fontSize: 12, color: 'var(--bd-text-tertiary)', marginTop: 2, paddingLeft: 4 }}>
                为什么是问题：{help.why}；影响：{help.impact}；处理：{help.fix}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 处理建议(只读)。建议内容由后端「确定性模板 + 可选模型改写」生成,前端只展示不编辑。 */
export function QualityAdviceBlock(props: { versionId: number }) {
  const query = useQuery({
    queryKey: ['quality-advice', props.versionId],
    queryFn: () => api.post<QualityAdviceResponse>('/assistant/quality-advice', { versionId: props.versionId }),
    staleTime: 60_000,
    retry: false,
  });
  if (query.isLoading) return <Spin size="small" />;
  if (!query.data) return null;
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ marginBottom: 4 }}>
        <Tag color={query.data.source === 'model' ? 'purple' : 'default'}>
          {query.data.source === 'model' ? 'AI 建议(仅供参考)' : '确定性处理建议'}
        </Tag>
      </div>
      <div style={{ border: '1px solid var(--bd-border)', borderRadius: 6, padding: '4px 10px', background: 'var(--bd-bg-fill)', maxHeight: 260, overflow: 'auto' }}>
        <Markdown text={query.data.advice} />
      </div>
    </div>
  );
}

export function QualityReportContent(props: {
  quality: QualityReportData;
  versionId?: number;
  onLocate?: (orgId: number, accountId: number) => void;
  /** 是否加载处理建议(定稿确认框等轻量场景可关闭) */
  withAdvice?: boolean;
}) {
  const { quality } = props;
  return (
    <div>
      <div>填报覆盖:{quality.coverage.filled}/{quality.coverage.total}</div>
      <Progress percent={quality.coverage.percent} size="small" />
      <div style={{ margin: '10px 0' }}>
        <Tag color="red">阻塞 {quality.blockingCount}</Tag>
        <Tag color="orange">提醒 {quality.warningCount}</Tag>
      </div>
      {(quality.groups?.length ?? 0) > 0 && (
        <div style={{ marginBottom: 10, fontSize: 12, color: 'var(--bd-text-secondary)' }}>
          {quality.groups!.map((group) => (
            <div key={group.code}>· {group.summary}</div>
          ))}
        </div>
      )}
      <QualityIssueList issues={quality.issues} help={quality.help} onLocate={props.onLocate} />
      {props.withAdvice && props.versionId != null && <QualityAdviceBlock versionId={props.versionId} />}
    </div>
  );
}
