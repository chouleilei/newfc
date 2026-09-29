/**
 * 编码/名称类展示规范(《界面展示细节完善方案》第一章)的共用列定义。
 *
 * 背景:编码、枚举码这类无空格长串此前各页手写列宽,定宽布局被相邻列裁掉、
 * 自适应布局撑歪整表。这里把「编码列怎么取宽、名称列怎么省略」固化成两个
 * 工厂函数,页面按需覆写 dataIndex/render,避免各处再各自为政。
 *
 * 宽度算法:编码按该类编码最大字符数 × 8px + 16px 内边距(方案一.1)。
 * 树形首列要额外吃掉层级缩进与展开按钮的宽度,用 treeIndentReserve 计算补偿。
 * 编码任何情况下不折行、不做中间截断,预留不够时尾部省略 + Tooltip 看全文。
 */
import { Tooltip, Typography } from 'antd';
import type { ColumnType } from 'antd/es/table';
import type { ReactNode } from 'react';

/** 列宽 = 最大字符数 × 8px + 16px 内边距(见方案一.1) */
const CHAR_WIDTH = 8;
const CODE_PADDING = 16;

export const CODE_WIDTH = {
  /** 组织编码 8 字符 */
  org: 8 * CHAR_WIDTH + CODE_PADDING,
  /** 科目编码:现规则深度 8 字符,预留 12 */
  account: 12 * CHAR_WIDTH + CODE_PADDING,
  /** 指标编码 3 字符 */
  metric: 3 * CHAR_WIDTH + CODE_PADDING,
  /** 预算表格编码 15 字符 */
  sheet: 15 * CHAR_WIDTH + CODE_PADDING,
  /** 测算规则码 18 字符 */
  calculationRule: 18 * CHAR_WIDTH + CODE_PADDING,
  /** 异常规则码 26 字符 */
  anomalyRule: 26 * CHAR_WIDTH + CODE_PADDING,
  /** 导入错误分类码 29 字符 */
  importErrorCategory: 29 * CHAR_WIDTH + CODE_PADDING,
} as const;

type CodeOverrides<T> = {
  title: ReactNode;
  dataIndex?: string;
  key?: string;
  width?: number;
  render?: (value: unknown, record: T, index: number) => ReactNode;
};

/**
 * 编码/枚举码/ID 列:等宽字体、单行省略 + Tooltip 看全文。
 * - 定宽:传 width(受控码按 CODE_WIDTH 取);预留不够时尾部省略,不涂到邻列。
 * - 不定宽:外部源编码等长度不受控的场景,交给 ellipsis,绝不撑歪整表。
 */
export function codeColumn<T>(overrides: CodeOverrides<T>): ColumnType<T> {
  const { width, render, ...rest } = overrides;
  return {
    ellipsis: { showTitle: false },
    ...(width != null ? { width } : {}),
    ...(render
      ? { render }
      : {
          render: (value: unknown) => {
            const text = value == null ? '' : String(value);
            if (!text) return '-';
            return <Tooltip title={text}><span style={{ fontFamily: 'monospace' }}>{text}</span></Tooltip>;
          },
        }),
    ...rest,
  };
}

type NameOverrides<T> = {
  title: ReactNode;
  dataIndex?: string;
  key?: string;
  width?: number;
  render?: (value: unknown, record: T, index: number) => ReactNode;
};

/**
 * 名称/标题列:单行省略 + antd Tooltip 看全文,不折成两行。
 * 列宽按常见长度取,不为「容下最长值」加宽 —— 最长值交给省略。
 */
export function nameColumn<T>(overrides: NameOverrides<T>): ColumnType<T> {
  const { render, ...rest } = overrides;
  return {
    ellipsis: { showTitle: false },
    ...(render
      ? { render }
      : {
          render: (value: unknown) => {
            const text = value == null ? '' : String(value);
            return <Tooltip title={text}>{text}</Tooltip>;
          },
        }),
    ...rest,
  };
}

/**
 * 长串内容(JSON、拼接明细)在单元格里的统一渲染:单行省略,
 * Tooltip 展示格式化全文(JSON 缩进 2 空格 + pre-wrap,限宽 ~420px)。
 * 原始 JSON 不做人话摘要 —— 摘要与「原因」列重复,依据的价值恰在审计原文。
 */
export function jsonCell(value: unknown): ReactNode {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  if (!raw) return '-';
  const pretty = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <Tooltip
      overlayStyle={{ maxWidth: 420 }}
      title={<pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 360, overflow: 'auto', fontSize: 12 }}>{pretty}</pre>}
    >
      <Typography.Text code style={{ fontSize: 12, whiteSpace: 'nowrap', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {raw}
      </Typography.Text>
    </Tooltip>
  );
}

/** 树形首列缩进补偿:最大深度 × 每级缩进 + 展开按钮位(见方案一.1/一.4) */
export function treeIndentReserve(maxDepth: number, indentStep = 16, expandButton = 24): number {
  return Math.max(0, maxDepth) * indentStep + expandButton;
}
