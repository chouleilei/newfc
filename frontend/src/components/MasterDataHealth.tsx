/**
 * 主数据健康体检(AI 功能增强计划 §四.阶段三)。
 *
 * - MasterDataHealthDrawer:体检报告抽屉,命中行可定位到主数据节点;
 *   行动(停用、改名、合并)仍由用户在主数据页手动执行,本抽屉只读。
 * - 报告全部来自确定性后端服务;结构检查与 /org/check、/account/check 同源。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Drawer, Empty, Space, Spin, Tag, Typography } from 'antd';
import { api } from '../api/client';

export type MasterDataSeverity = 'blocking' | 'warning' | 'info';

export interface MasterDataIssue {
  code: string;
  severity: MasterDataSeverity;
  message: string;
  orgId?: number;
  accountId?: number;
  relatedOrgId?: number;
  relatedAccountId?: number;
}

export interface MasterDataHelpEntry { why: string; impact: string; fix: string }

export interface MasterDataHealthReportData {
  issueCount: number;
  blockingCount: number;
  warningCount: number;
  infoCount: number;
  issues: MasterDataIssue[];
  groups: { code: string; severity: MasterDataSeverity; count: number; summary: string }[];
  help: Record<string, MasterDataHelpEntry>;
}

const SEVERITY_LABEL: Record<MasterDataSeverity, { color: string; label: string }> = {
  blocking: { color: 'red', label: '阻塞' },
  warning: { color: 'orange', label: '提醒' },
  info: { color: 'blue', label: '观察' },
};

interface SemanticNamePair {
  kind: 'org' | 'account';
  aCode: string;
  aName: string;
  bCode: string;
  bName: string;
  reason: string;
}

interface SemanticNameResponse {
  semanticAvailable: boolean;
  note: string;
  pairs: SemanticNamePair[];
  source: 'model';
  model: string;
  promptVersion: string;
}

/** 语义命名相似(模型建议,只读;未配置/关闭/失败时展示确定性说明,不影响上方报告)。 */
export function SemanticNameBlock() {
  const [requested, setRequested] = useState(false);
  const query = useQuery({
    queryKey: ['master-data-semantic-names'],
    queryFn: () => api.post<SemanticNameResponse>('/assistant/master-data-semantic-names', {}),
    enabled: requested,
    staleTime: 300_000,
    retry: false,
  });
  return (
    <div style={{ marginTop: 14, borderTop: '1px dashed var(--newfc-border)', paddingTop: 10 }}>
      {!requested ? (
        <Button size="small" onClick={() => setRequested(true)}>查找语义相似的重名候选(模型建议)</Button>
      ) : query.isLoading ? (
        <Spin size="small" />
      ) : query.data ? (
        <div>
          <div style={{ marginBottom: 6 }}>
            <Tag color="purple">AI 建议(仅供参考,永不作为事实)</Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{query.data.note}</Typography.Text>
          </div>
          {query.data.pairs.length > 0 && (
            <div style={{ maxHeight: 200, overflow: 'auto' }}>
              {query.data.pairs.map((pair, index) => (
                <div key={index} style={{ fontSize: 12, marginBottom: 4 }}>
                  <Tag>{pair.kind === 'org' ? '组织' : '科目'}</Tag>
                  {pair.aCode} {pair.aName} ↔ {pair.bCode} {pair.bName}
                  <Typography.Text type="secondary"> — {pair.reason}</Typography.Text>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <Typography.Text type="danger" style={{ fontSize: 12 }}>语义相似建议加载失败</Typography.Text>
      )}
    </div>
  );
}

function useMasterDataHealth(enabled: boolean) {
  return useQuery({
    queryKey: ['master-data-health'],
    queryFn: () => api.get<MasterDataHealthReportData>('/master-data/health'),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function MasterDataHealthContent(props: {
  report: MasterDataHealthReportData;
  onLocateOrg?: (orgId: number) => void;
  onLocateAccount?: (accountId: number) => void;
}) {
  const { report } = props;
  if (report.issueCount === 0) {
    return <Empty description="体检通过:主数据未发现结构、命名或数据卫生问题" />;
  }
  return (
    <div>
      {/* 汇总行:状态圆图标 + 计数(方案《排版工具与数据组件》二.3),
          阻塞→红 / 提醒→橙 / 观察→绿,三档语义色从 STATUS_COLOR 派生透明度 */}
      <Space size={20} wrap style={{ marginBottom: 12 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span className="newfc-status-icon newfc-status-icon-bad"><i className="ri-close-line" aria-hidden /></span>
          <Typography.Text>阻塞 <Typography.Text strong className="tabular-numbers">{report.blockingCount}</Typography.Text></Typography.Text>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span className="newfc-status-icon newfc-status-icon-warn"><i className="ri-alert-line" aria-hidden /></span>
          <Typography.Text>提醒 <Typography.Text strong className="tabular-numbers">{report.warningCount}</Typography.Text></Typography.Text>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span className="newfc-status-icon newfc-status-icon-ok"><i className="ri-check-line" aria-hidden /></span>
          <Typography.Text>观察 <Typography.Text strong className="tabular-numbers">{report.infoCount}</Typography.Text></Typography.Text>
        </span>
      </Space>
      {report.groups.length > 0 && (
        <div style={{ marginBottom: 10, fontSize: 12, color: 'var(--newfc-text-secondary)' }}>
          {report.groups.map((group) => (
            <div key={group.code}>· {group.summary}</div>
          ))}
        </div>
      )}
      <div style={{ maxHeight: 420, overflow: 'auto' }}>
        {report.issues.map((issue, index) => {
          const help = report.help[issue.code];
          const severity = SEVERITY_LABEL[issue.severity];
          const locateOrg = issue.orgId != null ? props.onLocateOrg : undefined;
          const locateAccount = issue.accountId != null ? props.onLocateAccount : undefined;
          return (
            <div key={`${issue.code}:${index}`} style={{ marginBottom: 8 }}>
              <Tag color={severity.color}>{severity.label}</Tag>
              <Tag>{issue.code}</Tag>
              {issue.message}
              {(locateOrg || locateAccount) && (
                <Button
                  size="small"
                  type="link"
                  onClick={() => (issue.orgId != null ? locateOrg?.(issue.orgId) : locateAccount?.(issue.accountId!))}
                >
                  定位
                </Button>
              )}
              {help && (
                <div style={{ fontSize: 12, color: 'var(--newfc-text-tertiary)', marginTop: 2, paddingLeft: 4 }}>
                  为什么是问题:{help.why};影响:{help.impact};处理:{help.fix}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 10 }}>
        处理动作(停用、改名、合并、迁移存量数据)请在组织/科目管理页手动执行;本报告只读。
      </Typography.Paragraph>
      <SemanticNameBlock />
    </div>
  );
}

export function MasterDataHealthDrawer(props: {
  open: boolean;
  onClose: () => void;
  onLocateOrg?: (orgId: number) => void;
  onLocateAccount?: (accountId: number) => void;
}) {
  const query = useMasterDataHealth(props.open);
  return (
    <Drawer title="主数据健康体检" width="min(560px, 94vw)" open={props.open} onClose={props.onClose} destroyOnClose>
      {query.isLoading ? (
        <Spin />
      ) : query.data ? (
        <MasterDataHealthContent report={query.data} onLocateOrg={props.onLocateOrg} onLocateAccount={props.onLocateAccount} />
      ) : (
        <Typography.Text type="danger">体检报告加载失败</Typography.Text>
      )}
    </Drawer>
  );
}

/** 触发按钮 + 抽屉;badge 汇总阻塞与提醒数。 */
export function MasterDataHealthTrigger(props: {
  onLocateOrg?: (orgId: number) => void;
  onLocateAccount?: (accountId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const badge = useMasterDataHealth(false);
  const count = badge.data ? badge.data.blockingCount + badge.data.warningCount : 0;
  return (
    <>
      <Badge count={count} size="small" offset={[-2, 2]}>
        <Button icon={<i className="ri-medicine-bottle-line" aria-hidden />} onClick={() => { setOpen(true); badge.refetch(); }}>主数据体检</Button>
      </Badge>
      <MasterDataHealthDrawer
        open={open}
        onClose={() => setOpen(false)}
        onLocateOrg={props.onLocateOrg}
        onLocateAccount={props.onLocateAccount}
      />
    </>
  );
}
