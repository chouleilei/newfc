import { Button, Result } from 'antd';
import { ApiError, errorText } from '../api/client';

interface QueryErrorResultProps {
  title: string;
  error: unknown;
  refetch: () => unknown;
}

/**
 * 组织范围类错误(AC-X04)不是临时故障:重试不会改变结果,需要换个范围或换账号。
 * - SCOPE_REQUIRED:账号授权了多个组织,须先在页面组织筛选里选定一个;
 * - SCOPE_RESTRICTED:集团口径内容,只对全组织账号开放。
 */
export function scopeErrorHint(error: unknown): { status: 'info' | 403; hint: string } | null {
  if (!(error instanceof ApiError)) return null;
  if (error.body.code === 'SCOPE_REQUIRED') return { status: 'info', hint: '请先在页面的组织筛选中选择一个已授权的组织。' };
  if (error.body.code === 'SCOPE_RESTRICTED') return { status: 403, hint: '当前账号只授权了部分组织,集团口径的内容请联系管理员查看。' };
  return null;
}

/** 页内查询失败态:失败优先于空态/骨架渲染;按「对象 + 原因 + 可执行动作」组织,附错误摘要与针对性重试。 */
export function QueryErrorResult({ title, error, refetch }: QueryErrorResultProps) {
  if (error == null) return null;
  const scope = scopeErrorHint(error);
  if (scope) {
    return <Result status={scope.status} title={title} subTitle={`${errorText(error)}。${scope.hint}`} />;
  }
  return (
    <Result
      status="error"
      title={title}
      subTitle={`${errorText(error)}。页面上次成功加载的数据（如有）可能已过时。`}
      extra={<Button type="primary" onClick={() => void refetch()}>重试</Button>}
    />
  );
}
