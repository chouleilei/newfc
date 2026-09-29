/**
 * 空状态插画:线条 + 单色的极简风,替换 antd 默认 Empty 灰图。
 *
 * 三张高频场景:无数据(表格/柱状)、无会话(对话气泡)、无搜索结果(放大镜)。
 * 线条色走 --bd-text-tertiary,点缀色走 --bd-primary,亮暗主题自动适配;
 * 不引入新色相,与全站「克制基底」的约束一致。
 *
 * 三种空状态要区分表达(UX-27):
 * - 首次使用:description 说明「还没有…」,children 放引导动作(新建/导入);
 * - 筛选无结果:传 onClearFilters,出现「清空筛选」并注明只恢复显示、不删数据;
 * - 系统失败:不要用本组件,改用 QueryErrorResult(失败不能伪装成空数据)。
 */
import { Button, Empty } from 'antd';
import type { ReactNode } from 'react';

export type EmptyKind = 'data' | 'chat' | 'search';

function Illustration({ kind }: { kind: EmptyKind }) {
  const stroke = 'var(--bd-text-tertiary)';
  const accent = 'var(--bd-primary)';
  const common = {
    width: 120,
    height: 90,
    viewBox: '0 0 120 90',
    fill: 'none',
    'aria-hidden': true as const,
  };
  if (kind === 'chat') {
    return (
      <svg {...common}>
        <rect x="22" y="18" width="76" height="44" rx="10" stroke={stroke} strokeWidth="2" opacity="0.6" />
        <path d="M44 62l-2 12 14-12" stroke={stroke} strokeWidth="2" strokeLinejoin="round" opacity="0.6" />
        <circle cx="46" cy="40" r="3" fill={accent} />
        <circle cx="60" cy="40" r="3" fill={stroke} opacity="0.5" />
        <circle cx="74" cy="40" r="3" fill={stroke} opacity="0.5" />
      </svg>
    );
  }
  if (kind === 'search') {
    return (
      <svg {...common}>
        <circle cx="54" cy="40" r="20" stroke={stroke} strokeWidth="2" opacity="0.6" />
        <path d="M69 55l14 14" stroke={stroke} strokeWidth="2.5" strokeLinecap="round" opacity="0.6" />
        <path d="M46 40h16" stroke={accent} strokeWidth="2" strokeLinecap="round" strokeDasharray="1 5" />
        <path d="M54 32v16" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeDasharray="1 5" opacity="0.5" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      {/* 空数据:坐标轴 + 三根空心柱,柱内虚线表示「待填」 */}
      <path d="M24 14v56h76" stroke={stroke} strokeWidth="2" strokeLinecap="round" opacity="0.6" />
      <rect x="36" y="42" width="14" height="28" rx="2" stroke={stroke} strokeWidth="2" strokeDasharray="3 4" opacity="0.55" />
      <rect x="58" y="30" width="14" height="40" rx="2" stroke={accent} strokeWidth="2" strokeDasharray="3 4" opacity="0.8" />
      <rect x="80" y="50" width="14" height="20" rx="2" stroke={stroke} strokeWidth="2" strokeDasharray="3 4" opacity="0.55" />
    </svg>
  );
}

/** 统一包装:插画 + 文案 + CTA 引导,样式与 antd Empty 兼容(可直接放进 List / Table locale.emptyText) */
export function BdEmpty({ kind = 'data', description, onClearFilters, children, style }: {
  kind?: EmptyKind;
  description?: ReactNode;
  /** 筛选无结果:提供一键清空筛选;清空只恢复显示范围,不删除任何数据 */
  onClearFilters?: () => void;
  children?: ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <Empty
      image={<Illustration kind={kind} />}
      imageStyle={{ height: 90 }}
      description={description}
      style={style}
    >
      {onClearFilters && (
        <div style={{ marginBottom: 8 }}>
          <Button size="small" onClick={onClearFilters}>清空筛选</Button>
          <div style={{ fontSize: 12, color: 'var(--bd-text-tertiary)', marginTop: 4 }}>清空筛选只是重新显示全部内容，不会删除任何数据</div>
        </div>
      )}
      {children}
    </Empty>
  );
}
