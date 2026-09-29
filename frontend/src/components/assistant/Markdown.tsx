/**
 * 助手回答的轻量 Markdown 渲染。
 *
 * 为什么自己写：模型回答里稳定出现 `###` 标题、`**加粗**`、GFM 表格和列表，
 * 而聊天区原来用 `whiteSpace: pre-wrap` 纯文本渲染，执行情况表会显示成一堆竖线。
 * 引入 react-markdown 会带进 20 余个 micromark 传递依赖，这里只需要固定的一小部分语法，
 * 因此实现一个确定性子集渲染器。
 *
 * 安全边界：**只输出 React 元素，不使用 dangerouslySetInnerHTML / innerHTML**，
 * 因此模型正文里的任何 HTML 片段都会被当作纯文本显示，不存在注入风险；
 * 链接只允许 http/https/mailto 与站内相对路径，其余原样显示为文本。
 */
import { Fragment, type ReactNode } from 'react';
import { Typography } from 'antd';

interface MarkdownProps {
  text: string;
  /** 供测试与埋点使用 */
  testId?: string;
}

const SAFE_LINK = /^(?:https?:\/\/|mailto:|\/(?!\/))/i;

/** 行内语法：加粗、斜体、行内代码、链接。按出现顺序切分，未匹配部分原样输出。 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}-i${index++}`;
    if (token.startsWith('`')) {
      nodes.push(<Typography.Text key={key} code>{token.slice(1, -1)}</Typography.Text>);
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('[')) {
      const split = token.indexOf('](');
      const label = token.slice(1, split);
      const href = token.slice(split + 2, -1);
      nodes.push(SAFE_LINK.test(href)
        ? <Typography.Link key={key} href={href} target="_blank" rel="noreferrer noopener">{label}</Typography.Link>
        : <Fragment key={key}>{token}</Fragment>);
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

function splitRow(line: string): string[] {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim());
}

/**
 * 块级解析。
 *
 * 逐行状态机，支持标题、围栏代码、GFM 表格、有序/无序列表、引用、分割线与段落。
 * 不支持的语法(脚注、任务列表嵌套等)按普通段落原样显示，绝不丢内容。
 */
function renderBlocks(text: string): ReactNode[] {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index];

    // 空行：块分隔
    if (!line.trim()) { index += 1; continue; }

    // 围栏代码块
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) { body.push(lines[index]); index += 1; }
      index += 1;
      out.push(
        <pre
          key={`b${key++}`}
          style={{
            margin: '8px 0', padding: '8px 10px', borderRadius: 6, overflowX: 'auto',
            background: 'rgba(127,127,127,0.12)', fontSize: 12, lineHeight: 1.6,
          }}
        >
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(5, heading[1].length) as 1 | 2 | 3 | 4 | 5;
      out.push(
        <Typography.Title key={`b${key++}`} level={level === 1 ? 4 : level === 2 ? 5 : 5} style={{ margin: '10px 0 6px' }}>
          {renderInline(heading[2], `h${key}`)}
        </Typography.Title>,
      );
      index += 1;
      continue;
    }

    // 分割线
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      out.push(<div key={`b${key++}`} style={{ borderTop: '1px solid rgba(127,127,127,0.25)', margin: '10px 0' }} />);
      index += 1;
      continue;
    }

    // GFM 表格：表头 + 分隔行 + 若干数据行
    if (line.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const header = splitRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(splitRow(lines[index]));
        index += 1;
      }
      out.push(
        <div key={`b${key++}`} style={{ overflowX: 'auto', margin: '8px 0' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 12, minWidth: '100%' }}>
            <thead>
              <tr>
                {header.map((cell, i) => (
                  <th
                    key={`th${i}`}
                    style={{
                      border: '1px solid rgba(127,127,127,0.28)', padding: '4px 8px', textAlign: 'left',
                      background: 'rgba(127,127,127,0.1)', whiteSpace: 'nowrap',
                    }}
                  >
                    {renderInline(cell, `th${i}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={`tr${r}`}>
                  {/*
                    列数取「表头列数」与「本行实际列数」的较大值：原来只按 header.map
                    渲染，模型多写一列时那格内容会被静默丢掉，与「绝不丢内容」的口径相悖。
                  */}
                  {Array.from({ length: Math.max(header.length, row.length) }, (_, c) => (
                    <td
                      key={`td${r}-${c}`}
                      style={{
                        border: '1px solid rgba(127,127,127,0.28)', padding: '4px 8px',
                        // 数字列右对齐更易核对；判定条件是「去掉千分位后是纯数值」
                        textAlign: /^[-+]?[\d,]+(\.\d+)?%?$/.test((row[c] ?? '').trim()) ? 'right' : 'left',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {renderInline(row[c] ?? '', `td${r}-${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // 列表(按缩进两级)
    const listMatch = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[2]);
      const items: { indent: number; text: string }[] = [];
      while (index < lines.length) {
        const item = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(lines[index]);
        if (!item) break;
        items.push({ indent: Math.floor(item[1].length / 2), text: item[3] });
        index += 1;
      }
      const ListTag = ordered ? 'ol' : 'ul';
      out.push(
        <ListTag key={`b${key++}`} style={{ margin: '4px 0 8px', paddingLeft: 22 }}>
          {items.map((item, i) => (
            <li key={`li${i}`} style={{ marginLeft: item.indent * 14, lineHeight: 1.75 }}>
              {renderInline(item.text, `li${i}`)}
            </li>
          ))}
        </ListTag>,
      );
      continue;
    }

    // 引用:与「首句摘要」同套竖线引述样式(.assistant-markdown blockquote,
    // 竖线为助手紫,见 index.css),不再用灰线内联样式
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        body.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      out.push(
        <blockquote key={`b${key++}`}>
          {renderInline(body.join('\n'), `q${key}`)}
        </blockquote>,
      );
      continue;
    }

    // 段落：连续非空、且不是其他块开头的行
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim()
      && !/^(#{1,6})\s+/.test(lines[index])
      && !/^\s*```/.test(lines[index])
      && !/^\s*>\s?/.test(lines[index])
      && !/^(\s*)([-*•]|\d+[.)])\s+/.test(lines[index])
      && !(lines[index].includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1]))) {
      paragraph.push(lines[index]);
      index += 1;
    }
    if (paragraph.length) {
      /* 首句摘要(方案《排版工具与数据组件》一.2):回答正文的第一段若是单行短句
         且以句号收尾、后面还有内容,判定为总结句,套助手紫竖线引述把「这是一句结论」视觉化。
         其余段落保持普通排版,长段落不用引述。 */
      const lead = paragraph[0].trim();
      const isSummaryLead = out.length === 0
        && paragraph.length === 1
        && lead.length > 0
        && lead.length <= 60
        && /[。！？!?]$/.test(lead)
        && lines.slice(index).some((remaining) => remaining.trim());
      out.push(
        isSummaryLead ? (
          <div key={`b${key++}`} className="bd-quote bd-quote-ai" style={{ margin: '0 0 8px' }}>
            {renderInline(lead, `p${key}`)}
          </div>
        ) : (
          <div key={`b${key++}`} style={{ margin: '0 0 6px', lineHeight: 1.8, whiteSpace: 'pre-wrap' }}>
            {renderInline(paragraph.join('\n'), `p${key}`)}
          </div>
        ),
      );
      continue;
    }
    index += 1;
  }
  return out;
}

export function Markdown({ text, testId }: MarkdownProps) {
  if (!text) return null;
  return <div data-testid={testId} className="assistant-markdown">{renderBlocks(text)}</div>;
}
