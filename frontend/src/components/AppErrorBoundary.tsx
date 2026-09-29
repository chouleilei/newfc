import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button, Result, Space } from 'antd';

interface State {
  error: Error | null;
}

/** 最后一层渲染异常兜底，避免单个坏配置或脏数据让整站白屏。 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled frontend render error', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Result
        status="error"
        title="页面发生异常"
        subTitle="当前页面无法继续显示。可返回首页或重新加载；尚未保存的本地编辑不会被自动提交。"
        extra={<Space><Button onClick={() => window.location.assign('/')}>返回首页</Button><Button type="primary" onClick={() => window.location.reload()}>重新加载</Button></Space>}
      />
    );
  }
}
