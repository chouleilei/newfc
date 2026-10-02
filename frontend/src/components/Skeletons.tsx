/**
 * 加载骨架屏:替换整页 Spin / Card loading 的「转圈等待」。
 *
 * 骨架描绘的是「即将出现的内容的轮廓」,等待感比转圈低——用户看到结构
 * 就知道会加载出什么。统一用 antd Skeleton 拼装,不手写闪烁 CSS。
 *
 * TableSkeleton:表头 + 5 行数据行的骨架(行列数可调);
 * CardSkeleton:卡片轮廓 + 标题行 + 2~3 行内容。
 */
import { Skeleton } from 'antd';

export function TableSkeleton({ columns = 3, rows = 5 }: { columns?: number; rows?: number }) {
  return (
    <div className="newfc-skeleton-table" aria-busy="true" aria-label="正在加载">
      <div className="newfc-skeleton-table-head" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
        {Array.from({ length: columns }, (_, i) => (
          <Skeleton.Button key={`h-${i}`} active size="small" block />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={`r-${r}`} className="newfc-skeleton-table-row" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
          {Array.from({ length: columns }, (_, c) => (
            <Skeleton.Input key={`c-${c}`} active size="small" block />
          ))}
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton({ lines = 3, chart = false }: { lines?: number; chart?: boolean }) {
  return (
    <div className="newfc-skeleton-card" aria-busy="true" aria-label="正在加载">
      <Skeleton active title={{ width: '38%' }} paragraph={false} />
      {chart ? (
        <Skeleton.Node active style={{ width: '100%', height: 180, marginTop: 16, borderRadius: 8 }} />
      ) : (
        <Skeleton active title={false} paragraph={{ rows: lines, width: ['92%', '76%', '60%'].slice(0, lines) }} style={{ marginTop: 12 }} />
      )}
    </div>
  );
}
