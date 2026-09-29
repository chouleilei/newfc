/**
 * 品牌 Logo:「预算表格 + 上升折线」的几何组合。
 *
 * 替换旧版实心色块 + antd 图标:实心块只是「一个蓝方块」,没有品牌识别度。
 * 图形语言——一张表格(预算的本体)上穿过一条上升折线(经营向好),
 * 全部用白色单线画在主色圆角方块里,亮暗主题都成立(暗色主色自动换浅蓝)。
 */
export function BrandLogo({ size = 28 }: { size?: number }) {
  return (
    <span
      className="bd-brand-logo"
     aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.29),
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <svg width={size * 0.68} height={size * 0.68} viewBox="0 0 20 20" fill="none">
        {/* 表格:外框 + 一条横线一条竖线,抽象自预算矩阵 */}
        <rect x="1.6" y="2.6" width="16.8" height="14.8" rx="2.4" stroke="currentColor" strokeWidth="1.5" opacity="0.55" />
        <path d="M1.6 7.4h16.8" stroke="currentColor" strokeWidth="1.5" opacity="0.55" />
        <path d="M8 7.4v10" stroke="currentColor" strokeWidth="1.5" opacity="0.55" />
        {/* 上升折线:压在表格之上,实心不透明 */}
        <path d="M4 14.6l3.6-3.2 2.6 2 5.4-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M13.2 8.2h2.4v2.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
