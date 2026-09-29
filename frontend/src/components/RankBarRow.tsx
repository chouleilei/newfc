/**
 * 构成排行行(方案《界面细节提升方案-排版工具与数据组件》二.2)。
 *
 * 每行 = 色点 + 名称 + 右侧数值/百分比 + 下方 7px 圆角轨道条。
 * 与环图/饼图同源:调用方传入图表同款颜色与同一份数据派生的占比,
 * 色样即「这行对应哪个切片」的图例。数值一律 tnum,金额口径由调用方给出。
 * 条宽过渡 0.2s,进 prefers-reduced-motion 时由 index.css 统一关闭。
 */
import type { CSSProperties } from 'react';

export interface RankBarRowProps {
  /** 色样与轨道条颜色(与对应图表切片同源) */
  color: string;
  /** 名称(超长省略) */
  label: string;
  /** 已格式化的显示值(万元口径由调用方给出) */
  value: string;
  /** 0–1,轨道条宽度 */
  share: number;
  /** 如 "96.5%" */
  shareLabel: string;
}

export function RankBarRow({ color, label, value, share, shareLabel }: RankBarRowProps) {
  const clamped = Math.min(Math.max(Number.isFinite(share) ? share : 0, 0), 1);
  return (
    <div className="bd-rank-row">
      <div className="bd-rank-row-main">
        <span className="bd-rank-dot" style={{ background: color }} aria-hidden />
        <span className="bd-rank-label" title={label}>{label}</span>
        <span className="bd-rank-value">{value}</span>
        <span className="bd-rank-share">{shareLabel}</span>
      </div>
      <div
        className="bd-rank-track"
        role="img"
        aria-label={`${label} 占比 ${shareLabel}`}
        style={{ '--rank-share': clamped } as CSSProperties}
      >
        <span className="bd-rank-bar" style={{ background: color }} />
      </div>
    </div>
  );
}
