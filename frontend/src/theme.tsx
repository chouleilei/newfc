/**
 * 主题系统:「年度账册」——暖白纸面 + 墨色正文 + 朱红/赭石点缀的编辑排版(方向 B)。
 *
 * 设计语言:
 * - 主形态是亮色:暖白纸面(#f6f3ee)代替冷灰,层级靠留白 + 发丝线 + 底色差;
 * - 墨色(#26221a)是正文与标题本色;朱红(#9c2f2f)只做点缀:眉题、当前标记、
 *   品牌墨线;赭金(#c08a00)仅用于导航选中下划与警示;
 * - KPI 大数字用 Fraunces 衬线(年报仪表感),眉题用 IBM Plex Mono 等宽档签,
 *   正文与表格金额仍走系统无衬线栈;
 * - 阴影只出现在**浮层**(抽屉/弹窗/下拉),平铺卡片一律零阴影。
 *
 * mode 持久化到 localStorage,首次访问跟随系统 prefers-color-scheme。
 * 同时为 ECharts 提供亮/暗基础配色(EChart 组件内与业务 option 合并)。
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { theme as antdTheme } from 'antd';

export type ThemeMode = 'light' | 'dark';

const STORAGE_KEY = 'budget-theme-mode';

interface ThemeContextValue {
  mode: ThemeMode;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({ mode: 'light', toggle: () => {} });

export function useThemeMode(): ThemeContextValue {
  return useContext(ThemeContext);
}

/**
 * 主色/重音/链接常量,供内联样式与图表复用,避免各处硬编码漂移。
 * primary=墨色(主按钮、主操作);accent=朱红(眉题、当前标记、引用竖线等点缀位);
 * link=朱红浅档。年度账册是「纸面+墨+朱砂印」的体系,不用蓝做强调。
 */
export const BRAND = {
  light: { primary: '#26221a', primaryDeep: '#171410', accent: '#9c2f2f', link: '#9c2f2f' },
  dark: { primary: '#e8e0cd', primaryDeep: '#f4edda', accent: '#d98a8a', link: '#d98a8a' },
} as const;

/**
 * 财务类型色:收入/成本/费用三方向,亮暗各一套。
 *
 * 刻意不占用红与绿 —— 红绿留给「好/坏」状态语义(colorSuccess/colorError)。
 * 账册体系里类型色取「账簿墨迹」色谱:收入=黛蓝(账簿蓝黑墨水)、成本=赭石、
 * 费用=黛紫。三类彼此可辨,且都不与朱红(点缀)/绛红(坏)语义冲突。
 */
export const FINANCE_COLOR = {
  light: { income: '#3a5a8c', cost: '#b45309', expense: '#6b4fa8', neutral: '#8a8069' },
  dark: { income: '#93b0d6', cost: '#e0a458', expense: '#b39ddb', neutral: '#a89e86' },
} as const;

/**
 * 状态语义色。与类型色严格分开:
 * 红绿只表达「好/坏/警告」,不表达「这是收入还是费用」。
 * 账册底上坏色=绛红(与点缀朱红同族但更深一档),好=苔绿,警=赭金。
 */
export const STATUS_COLOR = {
  light: { good: '#3e7d3e', warn: '#c08a00', bad: '#9c2f2f' },
  dark: { good: '#7db87d', warn: '#e0b64f', bad: '#d98a8a' },
} as const;

export function statusColor(mode: ThemeMode) {
  return STATUS_COLOR[mode];
}

export function brand(mode: ThemeMode) {
  return BRAND[mode];
}

export function financeColor(mode: ThemeMode) {
  return FINANCE_COLOR[mode];
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, mode);
    const root = document.documentElement;
    root.dataset.theme = mode;
    root.style.colorScheme = mode;
    const vars = mode === 'dark'
      ? {
        /* 暗色=「灯下夜账」:墨棕纸面,朱砂/赭石相应提亮 */
        '--bd-bg-layout': '#1c1914',
        '--bd-bg-container': '#24211a',
        '--bd-bg-elevated': '#2b2720',
        '--bd-bg-subtle': '#201d17',
        /* 岛内分区填充:比岛底更浅一档,靠底色差表达层级(不描边) */
        '--bd-bg-fill': '#2b2720',
        '--bd-island-border': '#3a352b',
        '--bd-border': '#3a352b',
        '--bd-border-subtle': '#322e25',
        '--bd-text': '#ece4d0',
        '--bd-text-secondary': '#b3a990',
        '--bd-text-tertiary': '#8a8069',
        '--bd-fill': '#2f2b22',
        /* 粘性表头填充:必须不透明,否则滚动时正文会从表头下面透出来 */
        '--bd-header': '#2b2720',
        '--bd-primary': BRAND.dark.primary,
        '--bd-primary-rgb': '232, 224, 205',
        '--bd-primary-bg': 'rgba(232, 224, 205, 0.14)',
        '--bd-accent': BRAND.dark.accent,
        '--bd-accent-rgb': '217, 138, 138',
        '--bd-accent-bg': 'rgba(217, 138, 138, 0.14)',
        '--bd-link': BRAND.dark.link,
        '--bd-link-rgb': '217, 138, 138',
        /* AI 助手面板专用:主推能力卡的紫调渐变与文字色 */
        '--bd-ai-card-bg': 'linear-gradient(91deg, #231d3a 0.73%, #2f2650 49.05%, #231d3a 102.77%)',
        '--bd-ai-card-bg-hover': 'linear-gradient(91deg, #2b2446 0.73%, #3a2f62 49.05%, #2b2446 102.77%)',
        '--bd-ai-card-title': '#c4b5fd',
        '--bd-ai-card-desc': '#9c8fc0',
        '--bd-ai-tile-bg': '#2b2720',
        '--bd-ai-tile-bg-hover': '#3a352b',
        /* AI 品牌签名:紫=AI 助手专属(FAB、AssistantMark、输入框流光、主推能力卡);
           亮/暗同值,两套主题下保持同一枚「紫印」 */
        '--bd-ai-primary': '#8b5cf6',
        '--bd-ai-primary-deep': '#6d28d9',
        '--bd-ai-glow': '#a78bfa',
        /* 浮层阴影:抽屉/弹窗/下拉专用,平铺卡片不用 */
        '--bd-shadow-overlay': '0 10px 15px -3px rgba(0, 0, 0, 0.5), 0 4px 6px -4px rgba(0, 0, 0, 0.45)',
        /* 动效时长两档令牌(亮暗同值):位移/投影走快档,描边淡入淡出走慢档 */
        '--bd-dur-lift': '0.22s',
        '--bd-dur-border': '0.45s',
        '--bd-ease-out': 'cubic-bezier(0.16, 1, 0.3, 1)',
      }
      : {
        '--bd-bg-layout': '#f6f3ee',
        '--bd-bg-container': '#fdfbf6',
        '--bd-bg-elevated': '#fdfbf6',
        '--bd-bg-subtle': '#f3eee5',
        /* 岛内分区填充:比岛底(#fdfbf6)深一档,靠底色差表达层级(不描边) */
        '--bd-bg-fill': '#f3eee5',
        '--bd-island-border': '#d8cfba',
        '--bd-border': '#e5ded0',
        '--bd-border-subtle': '#ece5d3',
        '--bd-text': '#26221a',
        '--bd-text-secondary': '#6b6252',
        '--bd-text-tertiary': '#8a8069',
        '--bd-fill': '#efe9dc',
        '--bd-header': '#f3eee5',
        '--bd-primary': BRAND.light.primary,
        '--bd-primary-rgb': '38, 34, 26',
        '--bd-primary-bg': 'rgba(38, 34, 26, 0.08)',
        '--bd-accent': BRAND.light.accent,
        '--bd-accent-rgb': '156, 47, 47',
        '--bd-accent-bg': 'rgba(156, 47, 47, 0.10)',
        '--bd-link': BRAND.light.link,
        '--bd-link-rgb': '156, 47, 47',
        '--bd-ai-card-bg': 'linear-gradient(91deg, #f6f3ff 0.73%, #ede6fe 49.05%, #f6f4ff 102.77%)',
        '--bd-ai-card-bg-hover': 'linear-gradient(91deg, #f1ebff 0.73%, #e0d4fc 49.05%, #f1ebff 102.77%)',
        '--bd-ai-card-title': '#4c1d95',
        '--bd-ai-card-desc': '#7e6f97',
        '--bd-ai-tile-bg': '#f3eee5',
        '--bd-ai-tile-bg-hover': '#ece5d3',
        '--bd-ai-primary': '#8b5cf6',
        '--bd-ai-primary-deep': '#6d28d9',
        '--bd-ai-glow': '#a78bfa',
        '--bd-shadow-overlay': '0 10px 15px -3px rgba(38, 34, 26, 0.10), 0 4px 6px -4px rgba(38, 34, 26, 0.08)',
        '--bd-dur-lift': '0.22s',
        '--bd-dur-border': '0.45s',
        '--bd-ease-out': 'cubic-bezier(0.16, 1, 0.3, 1)',
      };
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  }, [mode]);

  const value = useMemo(
    () => ({ mode, toggle: () => setMode((m) => (m === 'light' ? 'dark' : 'light')) }),
    [mode]
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * 正文与界面字体栈。
 *
 * IBM Plex Sans 自托管后置首位:它只有 latin 字形,中文自然落回
 * 系统字体(Windows 雅黑 / macOS 苹方 / Linux Noto CJK),栈结构一行未动。
 * Roboto 仍留在栈中,供未加载到 woff2 的离线场景与 Linux 桌面兜底。
 */
const FONT_FAMILY =
  "'IBM Plex Sans', Roboto, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Arial, sans-serif";

/** 数字专用栈:等宽数字(tabular-nums)由 CSS 变量控制,这里只保证字形落到有数字设计感的族。 */
export const NUMERIC_FONT_FAMILY =
  "'IBM Plex Sans', Roboto, 'Helvetica Neue', Arial, sans-serif";

/** 账册展示数字:KPI 大数字/Statistic/幽灵数字;Fraunces 衬线 latin-only,中文自然落系统字体。 */
export const DISPLAY_FONT_FAMILY =
  "'Fraunces', 'IBM Plex Sans', 'PingFang SC', 'Songti SC', 'SimSun', serif";

/** 眉题/档签等宽体:编号导航、FY 标签、区块眉题专用,不进正文与表格。 */
export const MONO_FONT_FAMILY =
  "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/**
 * 侧栏图标列左缘距侧栏边缘的距离,品牌区(App.tsx Brand)与菜单必须共用此值。
 * 菜单侧的横向缩进由 itemMarginInline + inlineIndent 合成 —— 注意 inline 模式下
 * rc-menu 会把 inlineIndent 以**内联样式**写到每个菜单项上,Menu 组件 token
 * itemPaddingInline 对其无效,不要从 token 侧推导。
 */
export const SIDER_INSET = 24;

/** 菜单项左右外边距。与 SIDER_INSET 联立:inlineIndent = SIDER_INSET - SIDER_MENU_MARGIN。 */
export const SIDER_MENU_MARGIN = 8;

/**
 * AntD 主题 token。
 * 圆角梯度:小 4 / 常规 6 / 卡片与浮层 12。
 * 卡片阴影一律置零(boxShadowTertiary),层级由发丝边框与底色差承担。
 */
export function useAntdTheme() {
  const { mode } = useThemeMode();
  return useMemo(() => {
    if (mode === 'dark') {
      return {
        algorithm: antdTheme.darkAlgorithm,
        token: {
          colorPrimary: BRAND.dark.primary,
          colorLink: BRAND.dark.link,
          colorInfo: BRAND.dark.link,
          /* 语义 token 一律取状态色,不再借用类型色:
             否则「费用」与「出错」同为红,读者要靠上下文分辨颜色在说什么。 */
          colorSuccess: STATUS_COLOR.dark.good,
          colorWarning: STATUS_COLOR.dark.warn,
          colorError: STATUS_COLOR.dark.bad,
          borderRadius: 6,
          borderRadiusLG: 12,
          borderRadiusSM: 4,
          fontFamily: FONT_FAMILY,
          /* 与亮色同梯度,保证两套主题下信息密度一致 */
          fontSize: 13,
          fontSizeSM: 12,
          fontSizeLG: 15,
          fontSizeHeading1: 22,
          fontSizeHeading2: 18,
          fontSizeHeading3: 18,
          fontSizeHeading4: 15,
          fontSizeHeading5: 13,
          colorBgLayout: '#1c1914',
          colorBgContainer: '#24211a',
          colorBgElevated: '#2b2720',
          colorBorder: '#3a352b',
          colorBorderSecondary: '#322e25',
          colorText: '#ece4d0',
          colorTextSecondary: '#b3a990',
          colorTextTertiary: '#8a8069',
          boxShadowTertiary: 'none',
        },
        components: {
          Card: { headerHeight: 46, borderRadiusLG: 12, paddingLG: 20, boxShadowTertiary: 'none' },
          Table: {
            headerBg: '#2b2720',
            headerColor: '#b3a990',
            headerSplitColor: '#3a352b',
            rowHoverBg: 'rgba(236, 228, 208, 0.04)',
            borderColor: '#322e25',
            borderRadius: 8,
            cellPaddingBlockSM: 8,
          },
          Menu: {
            itemBorderRadius: 6,
            itemMarginInline: SIDER_MENU_MARGIN,
            itemHeight: 38,
            /* 账册选中 = 墨色 14% 淡底 + 加粗墨色文字;下划金线由 CSS 层叠加 */
            darkItemBg: 'transparent',
            darkSubMenuItemBg: 'transparent',
            darkItemColor: '#b3a990',
            darkItemHoverBg: 'rgba(236, 228, 208, 0.06)',
            darkItemHoverColor: '#ece4d0',
            darkItemSelectedBg: 'rgba(232, 224, 205, 0.14)',
            darkItemSelectedColor: '#f4edda',
            darkItemSelectedIconColor: '#f4edda',
            itemSelectedBg: 'rgba(232, 224, 205, 0.14)',
            itemSelectedColor: '#f4edda',
            itemHoverBg: 'rgba(236, 228, 208, 0.06)',
          },
          /* 暗色下折叠触发条默认底色与被 .bd-sider 覆盖的侧栏底色不一致;
             置透明让侧栏底色透出来。 */
          Layout: { triggerBg: 'transparent' },
          Segmented: { itemSelectedBg: '#3a352b', itemSelectedColor: '#ece4d0', trackBg: '#201d17', borderRadius: 6 },
          Button: { borderRadius: 6, primaryShadow: 'none', defaultShadow: 'none', dangerShadow: 'none' },
          Input: { borderRadius: 6 },
          Drawer: { paddingLG: 20 },
          Tag: { borderRadiusSM: 4, defaultBg: '#2f2b22', defaultColor: '#b3a990' },
          Progress: { defaultColor: BRAND.dark.accent },
          Tooltip: { colorBgSpotlight: '#3a352b' },
        },
      };
    }
    return {
      token: {
        /* 主按钮 hover/active 由 index.css 的 .ant-btn-primary 规则按亮/暗各定一档,
           token 侧不再给算法色,避免两套 hover 方案互相打架 */
        colorPrimary: BRAND.light.primary,
        colorPrimaryBg: 'rgba(38, 34, 26, 0.08)',
        colorPrimaryBgHover: 'rgba(38, 34, 26, 0.14)',
        colorLink: BRAND.light.link,
        colorInfo: BRAND.light.link,
        /* 语义 token 一律取状态色,不再借用类型色(理由同暗色分支) */
        colorSuccess: STATUS_COLOR.light.good,
        colorWarning: STATUS_COLOR.light.warn,
        colorError: STATUS_COLOR.light.bad,
        borderRadius: 6,
        borderRadiusLG: 12,
        borderRadiusSM: 4,
        fontFamily: FONT_FAMILY,
        /* 字号梯度:正文基准 13px,次级 12px / 区块标题 15px / 页级 18px / 主标 22px。 */
        fontSize: 13,
        fontSizeSM: 12,
        fontSizeLG: 15,
        fontSizeHeading1: 22,
        fontSizeHeading2: 18,
        fontSizeHeading3: 18,
        fontSizeHeading4: 15,
        fontSizeHeading5: 13,
        colorBgLayout: '#f6f3ee',
        colorBgContainer: '#fdfbf6',
        colorBgElevated: '#fdfbf6',
        colorBorder: '#e5ded0',
        colorBorderSecondary: '#ece5d3',
        colorText: '#26221a',
        colorTextSecondary: '#6b6252',
        colorTextTertiary: '#8a8069',
        colorTextQuaternary: '#a89e86',
        colorFillQuaternary: '#f6f2ea',
        colorFillTertiary: '#efe9dc',
        /* 平铺卡片零阴影:层级交给 1px 发丝边框与底色差 */
        boxShadowTertiary: 'none',
      },
      components: {
        Card: {
          headerHeight: 46,
          borderRadiusLG: 12,
          paddingLG: 20,
          boxShadowTertiary: 'none',
        },
        Table: {
          headerBg: '#f3eee5',
          headerColor: '#6b6252',
          headerSplitColor: '#e5ded0',
          rowHoverBg: '#f6f2ea',
          borderColor: '#ece5d3',
          borderRadius: 8,
          cellPaddingBlockSM: 8,
        },
        Menu: {
          itemBorderRadius: 6,
          itemMarginInline: SIDER_MENU_MARGIN,
          itemHeight: 38,
          /* 选中态:墨色 8% 淡底 + 墨色加粗文字(金线下划由 CSS 层叠加) */
          itemSelectedBg: 'rgba(38, 34, 26, 0.08)',
          itemSelectedColor: '#26221a',
          itemHoverBg: 'rgba(38, 34, 26, 0.05)',
          itemHoverColor: '#26221a',
          itemColor: '#6b6252',
          subMenuItemBg: 'transparent',
        },
        Segmented: {
          itemSelectedBg: '#fdfbf6',
          itemSelectedColor: '#26221a',
          itemHoverColor: '#26221a',
          trackBg: '#efe9dc',
          borderRadius: 6,
        },
        Button: {
          borderRadius: 6,
          defaultBorderColor: '#d8cfba',
          defaultColor: '#6b6252',
          primaryShadow: 'none',
          defaultShadow: 'none',
          dangerShadow: 'none',
        },
        Tag: {
          borderRadiusSM: 4,
          defaultBg: '#efe9dc',
          defaultColor: '#6b6252',
        },
        Input: {
          borderRadius: 6,
          activeBorderColor: '#26221a',
          hoverBorderColor: '#a89e86',
        },
        Select: { borderRadius: 6 },
        Drawer: { paddingLG: 20 },
        Alert: { borderRadiusLG: 8 },
        Tooltip: { colorBgSpotlight: '#3a352b' },
      },
    };
  }, [mode]);
}

/**
 * ECharts 基础配色。
 * 前三位刻意与 FINANCE_COLOR 对齐(收入/成本/费用),让图表系列色与页面标签色同源。
 * 调色板避开红绿:系列色只做「区分」,好坏判断交给正负值与 tooltip 文案。
 * 账册体系:黛蓝(首选)/赭石/黛紫/苔青/灰,纸面与夜账底分别调档。
 */
export function chartTheme(mode: ThemeMode) {
  return mode === 'dark'
    ? {
        colors: ['#93b0d6', '#e0a458', '#b39ddb', '#7fb8a8', '#b3a990', '#8a8069'],
        text: '#b3a990',
        subText: '#8a8069',
        axisLine: '#3a352b',
        splitLine: '#322e25',
        tooltipBg: 'rgba(43, 39, 32, 0.96)',
        tooltipText: '#ece4d0',
        accent: BRAND.dark.accent,
        glow: false,
      }
    : {
        colors: ['#3a5a8c', '#b45309', '#6b4fa8', '#4a7d6b', '#8a8069', '#b6ac94'],
        text: '#6b6252',
        subText: '#8a8069',
        axisLine: '#e5ded0',
        splitLine: '#ece5d3',
        tooltipBg: 'rgba(253, 251, 246, 0.98)',
        tooltipText: '#26221a',
        accent: BRAND.light.accent,
        glow: false,
      };
}

/** #rrggbb -> rgba(),用于图表渐变(避免手写多份色值) */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** 折线图区域渐变填充(自上而下淡出) */
export function areaGradient(color: string, topAlpha = 0.16, bottomAlpha = 0.01) {
  return {
    type: 'linear' as const,
    x: 0, y: 0, x2: 0, y2: 1,
    colorStops: [
      { offset: 0, color: withAlpha(color, topAlpha) },
      { offset: 1, color: withAlpha(color, bottomAlpha) },
    ],
  };
}

/**
 * 主折线样式。旧版带 12px 外发光,在浅色底上把线条糊成一团;
 * 现在只保留一层极淡的落影用于和网格线分离。
 */
export function glowLineStyle(color: string, width = 2) {
  return { width, color, shadowBlur: 4, shadowColor: withAlpha(color, 0.18), shadowOffsetY: 1 };
}

/** 图表轴标签用万元格式(cents 直转) */
export function wanAxisLabel(v: number): string {
  const wan = v / 1_000_000;
  if (Math.abs(wan) >= 10000) return `${(wan / 10000).toFixed(1)}亿`;
  return `${wan.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}万`;
}
