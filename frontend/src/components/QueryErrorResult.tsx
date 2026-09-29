import { Button, Result } from 'antd';
import { errorText } from '../api/client';

interface QueryErrorResultProps {
  title: string;
  error: unknown;
  refetch: () => unknown;
}

/** 页内查询失败态:失败优先于空态/骨架渲染;按「对象 + 原因 + 可执行动作」组织,附错误摘要与针对性重试。 */
export function QueryErrorResult({ title, error, refetch }: QueryErrorResultProps) {
  if (error == null) return null;
  return (
    <Result
      status="error"
      title={title}
      subTitle={`${errorText(error)}。页面上次成功加载的数据（如有）可能已过时。`}
      extra={<Button type="primary" onClick={() => void refetch()}>重试</Button>}
    />
  );
}
