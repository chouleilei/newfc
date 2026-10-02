/**
 * 统一工作范围条(方案《易用性与直觉化交互实施方案》§4.1,任务 UX-04)。
 *
 * 在所有录入/分析工作区顶部持续回答「我正在处理哪一年、哪个组织、哪一版数据」:
 *   2026 年 · A 电站 · 年初预算(当前采用) · 累计实际截至 08-31 · 金额:万元
 *
 * 约定:
 * - 数据日期区分「来源」(服务器现有累计的截止日,中性)与「待提交」(本次保存将写入的
 *   截止日,accent 色),两者一致时只显示来源,避免同屏两个日期互相稀释;
 * - 状态分档:ready(默认) / loading(范围数据切换中,骨架占位,不混显旧范围数值) /
 *   invalid(范围失效,warning 色 + 原因) / readonly(只读口径,如已定稿);
 * - 长名称截断展示,Tooltip 提供可访问全文;
 * - 纯展示组件:不取数、不导航,范围由页面(同一份 URL 解析结果)传入。
 */
import { Skeleton, Tooltip, Typography } from 'antd';
import type { ReactNode } from 'react';

export interface WorkspaceScopeBarProps {
  /** 业务年度。 */
  year?: number | null;
  /** 组织范围名称;缺省表示全部组织。 */
  orgName?: string | null;
  /** 预算版本名称。 */
  versionName?: string | null;
  /** 版本/编辑状态文案,如「草稿」「已定稿」「当前预算」「年度已冻结」。 */
  statusLabel?: string | null;
  /** 状态分档:loading=切换中骨架;invalid=范围失效(配 issues 原因);readonly=只读口径。 */
  status?: 'ready' | 'loading' | 'invalid' | 'readonly';
  /** 等价于 status="loading" 的便捷写法(切换年度等异步窗口);显式 status 优先。 */
  loading?: boolean;
  /** 来源日期:服务器现有累计实际的截止日。 */
  asOfDate?: string | null;
  /** 待提交日期:本次保存将使用的截止日;与来源一致时省略。 */
  pendingDate?: string | null;
  /** 金额单位,默认「万元」。 */
  unit?: string;
  /** 范围失效/未就绪原因列表(status=invalid 时逐条进 Tooltip)。 */
  issues?: string[];
  /** 追加的自定义条目(如科目表名)。 */
  extra?: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

function ScopeValue({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <Tooltip title={title} mouseEnterDelay={0.3}>
      <Typography.Text className="newfc-scope-bar-value" title={undefined}>
        {children}
      </Typography.Text>
    </Tooltip>
  );
}

export default function WorkspaceScopeBar(props: WorkspaceScopeBarProps) {
  const {
    year, orgName, versionName, statusLabel, loading = false,
    asOfDate, pendingDate, unit = '万元', issues, extra, className, style,
  } = props;
  const status = props.status ?? (loading ? 'loading' : 'ready');

  if (status === 'loading') {
    return (
      <div className={`newfc-scope-bar${className ? ` ${className}` : ''}`} style={style} aria-busy="true" aria-label="工作范围加载中">
        <Skeleton.Input active size="small" style={{ width: 280, height: 22 }} />
      </div>
    );
  }

  const showPending = pendingDate != null && pendingDate !== '' && pendingDate !== asOfDate;
  const items: ReactNode[] = [];

  if (year != null) items.push(<ScopeValue key="year" title={`${year} 年`}>{year} 年</ScopeValue>);
  items.push(
    <ScopeValue key="org" title={orgName ?? '全部组织'}>
      <span className="newfc-scope-bar-label">组织</span> {orgName ?? '全部'}
    </ScopeValue>,
  );
  if (versionName) items.push(<ScopeValue key="version" title={versionName}>{versionName}</ScopeValue>);
  if (statusLabel) {
    items.push(
      <span
        key="status"
        className={`newfc-scope-bar-status${status === 'invalid' ? ' newfc-scope-bar-status-invalid' : status === 'readonly' ? ' newfc-scope-bar-status-readonly' : ''}`}
      >
        {statusLabel}
      </span>,
    );
  }
  if (asOfDate) items.push(<ScopeValue key="asof" title={`服务器现有累计实际截至 ${asOfDate}`}><span className="newfc-scope-bar-label">实际截至</span> {asOfDate}</ScopeValue>);
  if (showPending) {
    items.push(
      <span key="pending" className="newfc-scope-bar-pending" title={`本次保存将写入截至 ${pendingDate} 的累计值`}>
        待提交截止 {pendingDate}
      </span>,
    );
  }
  items.push(<ScopeValue key="unit"><span className="newfc-scope-bar-label">金额</span> {unit}</ScopeValue>);
  if (extra) items.push(extra);

  return (
    <div
      className={`newfc-scope-bar${status === 'invalid' ? ' newfc-scope-bar-invalid' : ''}${className ? ` ${className}` : ''}`}
      style={style}
      aria-label="当前工作范围"
    >
      {status === 'invalid' && (
        <Tooltip title={(issues ?? []).length ? (issues ?? []).join('；') : '范围参数无效'}>
          <span className="newfc-scope-bar-status newfc-scope-bar-status-invalid" role="alert">
            <i className="ri-error-warning-line" aria-hidden /> 范围已失效
            {/* Tooltip 内容悬停才进 DOM;原因同时给屏幕阅读器一份纯文本 */}
            {(issues ?? []).length > 0 && <span className="newfc-sr-only">:{(issues ?? []).join('；')}</span>}
          </span>
        </Tooltip>
      )}
      {items.map((item, index) => (
        <span key={index} className="newfc-scope-bar-item">
          {index > 0 && <span className="newfc-scope-bar-sep" aria-hidden>·</span>}
          {item}
        </span>
      ))}
    </div>
  );
}
