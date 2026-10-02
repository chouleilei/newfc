/**
 * 金额排版组件:全站金额的唯一排版出口。
 *
 * 组件只管排版,不管换算 —— 数值一律取自 utils/money.ts 的既有口径
 * (`centsToWan` / `centsCompact`),避免引入格式化口径漂移。
 *
 * 排版规格(《视觉高级感提升方案》3.1):
 * - 整数:基准字号,字重 600,--newfc-text
 * - 小数:基准 × 0.75,字重 600,--newfc-text-secondary
 * - 单位:12px,字重 400,--newfc-text-tertiary,与数字基线对齐
 * - 符号:默认中性(--newfc-text-secondary);仅当调用方显式传 tone 时才上语义色
 *
 * 符号色纪律:组件**不按正负自动上语义色**。红绿只表达好/坏,而负数不等于坏 ——
 * 费用的负数是冲回,把冲回涂红会让「费用超支」与「费用冲回」同色,正是 v0.2.2
 * 要消灭的串台。tone 只在调用方**已经判定了好坏**的场合(完成率偏差、结余/超支)
 * 显式传入。
 *
 * 口径归属:组件原样渲染换算结果的符号;成本/费用「显示为正」的利润方向翻转
 * 由**调用方**负责(如 cents={-(costCents)}),组件不做隐式翻转,避免双重翻转。
 */
import { centsCompact, centsToWan, centsToYuanGrouped } from '../utils/money';
import { NUMERIC_FONT_FAMILY, statusColor, useThemeMode } from '../theme';

export type MoneySize = 'sm' | 'md' | 'lg';
/** neutral 不表态;good/bad 只在调用方已判定好坏后显式传入 */
export type MoneyTone = 'neutral' | 'good' | 'bad';

/** 展示层字体:与 index.css 的 .kpi-value 同源,KPI 大数字用 Fraunces 衬线账册感 */
const DISPLAY_FONT_FAMILY = "'Fraunces', " + NUMERIC_FONT_FAMILY;

const BASE_FONT_SIZE: Record<MoneySize, number> = { sm: 12, md: 13, lg: 20 };

export interface MoneyTextProps {
  /** 金额,单位:分 */
  cents: number;
  /** 字号档:sm 12 / md 13(默认) / lg 20 */
  size?: MoneySize;
  /** 强制带正负号(用于增减额这类必须显式表态的场合) */
  showSign?: boolean;
  /** 符号与主体的语义色,默认 neutral(墨色,不表态) */
  tone?: MoneyTone;
  /**
   * 整体着色:类型色等调用方自有的颜色,作用于符号/整数/小数三段
   * (单位段恒为三级灰,不跟随)。与 tone 二选一,同时给出时以 color 为准。
   */
  color?: string;
  /**
   * 数值口径:
   * - 'wan':万元(默认),取 centsToWan,单位后缀「万元」
   * - 'compact':大额智能缩写,取 centsCompact(亿/万/元),单位后缀随档位变化
   */
  format?: 'wan' | 'compact';
  /** 不渲染单位后缀(表头、轴标签等已声明单位的场合) */
  hideUnit?: boolean;
  className?: string;
  style?: React.CSSProperties;
  /** 悬停提示;缺省自动给「精确值 x,xxx.xx 元」,让万元两位小数之下的小额差异仍可核对 */
  title?: string;
}

/** 拆解数值主体与尾随单位:"1,234.57" -> body="1,234.57";"21.32 亿" -> body="21.32", unit="亿" */
function splitValue(text: string): { body: string; unit: string } {
  const m = /^([+-]?[\d,]+(?:\.\d+)?)\s*([^\d\s]+)?$/.exec(text.trim());
  if (!m) return { body: text, unit: '' };
  return { body: m[1], unit: m[2] ?? '' };
}

/** 拆出符号/整数/小数三段:"-1,234.57" -> { sign:'-', int:'1,234', dec:'.57' } */
function splitNumber(body: string): { sign: string; int: string; dec: string } {
  const sign = body.startsWith('-') ? '-' : body.startsWith('+') ? '+' : '';
  const rest = sign ? body.slice(1) : body;
  const dot = rest.lastIndexOf('.');
  if (dot === -1) return { sign, int: rest, dec: '' };
  return { sign, int: rest.slice(0, dot), dec: rest.slice(dot) };
}

const ZERO_RE = /^0(?:\.0+)?$/;

export function MoneyText({
  cents,
  size = 'md',
  showSign = false,
  tone = 'neutral',
  color,
  format = 'wan',
  hideUnit = false,
  className,
  style,
  title,
}: MoneyTextProps) {
  const { mode } = useThemeMode();
  const text = format === 'compact' ? centsCompact(cents) : centsToWan(cents);
  const { body, unit } = splitValue(text);
  const { sign: rawSign, int, dec } = splitNumber(body);

  /* 强制带号时给非零值补 '+';零值不表态(与 money.ts 的「零不带负号」一致) */
  const sign = rawSign || (showSign && !ZERO_RE.test(int + dec) ? '+' : '');

  const base = BASE_FONT_SIZE[size];
  const status = statusColor(mode);
  const toneColor = color ?? (tone === 'good' ? status.good : tone === 'bad' ? status.bad : undefined);

  return (
    <span
      className={className ? `newfc-money-text ${className}` : 'newfc-money-text'}
      style={{
        fontFamily: size === 'lg' ? DISPLAY_FONT_FAMILY : NUMERIC_FONT_FAMILY,
        /* 等宽数字由组件强制施加,不依赖调用方类名 */
        fontVariantNumeric: 'tabular-nums',
        fontSize: base,
        fontWeight: 600,
        lineHeight: 1.25,
        color: toneColor ?? 'var(--newfc-text)',
        whiteSpace: 'nowrap',
        /* 单位与数字基线对齐靠组件自身保证,不依赖调用方套 flex 容器 */
        display: 'inline-flex',
        alignItems: 'baseline',
        ...style,
      }}
      title={title ?? `精确值 ${centsToYuanGrouped(cents)} 元`}
    >
      {sign ? (
        <span style={{ color: toneColor ?? 'var(--newfc-text-secondary)' }}>{sign}</span>
      ) : null}
      <span>{int}</span>
      {dec ? (
        /* 小数段默认次级灰;显式 tone 时跟随主体,避免一个数字里出现两种色 */
        <span style={{ fontSize: '0.75em', color: toneColor ?? 'var(--newfc-text-secondary)' }}>{dec}</span>
      ) : null}
      {!hideUnit ? (
        <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--newfc-text-tertiary)', marginLeft: 3 }}>
          {format === 'wan' ? '万元' : unit}
        </span>
      ) : null}
    </span>
  );
}

export default MoneyText;
