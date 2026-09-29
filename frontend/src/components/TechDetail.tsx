import { Popover, Typography } from 'antd';
import type { ReactNode } from 'react';

/**
 * 业务摘要 + 折叠的「技术详情」入口。
 * 列表首屏只展示业务摘要(对象、期间、变化数量),原始 JSON/内部字段保留在
 * 点击展开的浮层里供审计核对,不再直接铺满单元格。
 */
export function TechDetail({ summary, raw }: { summary: ReactNode; raw: unknown }) {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
  return (
    <span>
      {summary}
      {text ? (
        <Popover
          trigger="click"
          overlayStyle={{ maxWidth: 420 }}
          content={<pre style={{ margin: 0, maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 12 }}>{text}</pre>}
        >
          <Typography.Link style={{ marginLeft: 6, fontSize: 12, whiteSpace: 'nowrap' }}>技术详情</Typography.Link>
        </Popover>
      ) : null}
    </span>
  );
}
