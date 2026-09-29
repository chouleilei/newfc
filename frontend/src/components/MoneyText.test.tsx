// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider } from 'antd';
import MoneyText from './MoneyText';
import { centsToWan, centsCompact } from '../utils/money';

/** MoneyText 在 ThemeProvider 之外取 context 默认 mode='light',单测无需包裹主题。 */
const render = (node: React.ReactElement) => renderToStaticMarkup(<ConfigProvider>{node}</ConfigProvider>);

/** 去掉标签与属性,只留可见文本,便于断言排版分段的拼接结果 */
const text = (node: React.ReactElement) => render(node).replace(/<[^>]*>/g, '');

const WAN = 1_000_000; // 1 万元 = 10^6 分

describe('MoneyText 数值口径', () => {
  it('默认走 centsToWan 万元口径并补「万元」单位', () => {
    // 1 万元 = 10^6 分:-123456789 分 = -123.456789 万元
    expect(text(<MoneyText cents={-123456789} />)).toBe('-123.46万元');
  });

  it('零值与不足一分时都不带负号(centsToWan 的零值口径)', () => {
    expect(text(<MoneyText cents={0} />)).toBe('0.00万元');
    expect(text(<MoneyText cents={-1} />)).toBe('0.00万元');
  });

  it('compact 档沿用 centsCompact 口径,单位随档位变化', () => {
    expect(text(<MoneyText cents={213_200_000_000} format="compact" />)).toBe('21.32亿');
    expect(text(<MoneyText cents={78_400_000} format="compact" />)).toBe('78.40万');
    /* 元档 centsCompact 本身不带后缀,组件也不该凭空补一个 */
    expect(text(<MoneyText cents={1234} format="compact" />)).toBe('12.34');
  });

  it('compact 档数值与 centsCompact 完全一致(无口径漂移)', () => {
    for (const cents of [0, 1, -1, 9999, 10_000, 123_456_789, -987_654_321, 5_000_000_000_000]) {
      expect(text(<MoneyText cents={cents} format="compact" />))
        .toBe(centsCompact(cents).replace(' ', ''));
    }
  });

  it('wan 档数值与 centsToWan 完全一致(无口径漂移)', () => {
    for (const cents of [0, 1, -1, WAN, -WAN, 123_456_789, -987_654_321]) {
      expect(text(<MoneyText cents={cents} />)).toBe(`${centsToWan(cents)}万元`);
    }
  });

  it('不做隐式符号翻转:成本/费用的翻转由调用方负责', () => {
    const costCents = -50 * WAN;
    expect(text(<MoneyText cents={costCents} />)).toBe('-50.00万元');
    expect(text(<MoneyText cents={-costCents} />)).toBe('50.00万元');
  });
});

describe('MoneyText 排版规格', () => {
  it('小数段为 0.75em 的次级灰,整数段为墨色', () => {
    const html = render(<MoneyText cents={123456789} />);
    expect(html).toContain('font-size:13px');
    expect(html).toContain('font-variant-numeric:tabular-nums');
    /* 小数 .57 单独成段并降为次级灰 */
    expect(html).toContain('font-size:0.75em');
    expect(html).toContain('--bd-text-secondary');
  });

  it('单位段为 12px / 400 / 三级灰', () => {
    const html = render(<MoneyText cents={123456789} />);
    expect(html).toContain('font-size:12px');
    expect(html).toContain('font-weight:400');
    expect(html).toContain('--bd-text-tertiary');
  });

  it('hideUnit 时不渲染单位段', () => {
    expect(text(<MoneyText cents={123456789} hideUnit />)).toBe('123.46');
  });

  it('size=lg 走 Fraunces 衬线展示字体', () => {
    expect(render(<MoneyText cents={123456789} size="lg" />)).toContain('Fraunces');
    expect(render(<MoneyText cents={123456789} />)).not.toContain('Fraunces');
  });
});

describe('MoneyText 符号纪律', () => {
  it('负号默认中性(次级灰),不自动上语义色', () => {
    const html = render(<MoneyText cents={-123456789} />);
    expect(html).not.toContain('#9c2f2f');
    expect(html).not.toContain('#3e7d3e');
    expect(html).toContain('--bd-text-secondary');
  });

  it('showSign 给正数补正号,零值仍不表态', () => {
    expect(text(<MoneyText cents={123456789} showSign />)).toBe('+123.46万元');
    expect(text(<MoneyText cents={0} showSign />)).toBe('0.00万元');
  });

  it('tone 显式传色时才上语义色(亮色档取 STATUS_COLOR)', () => {
    expect(render(<MoneyText cents={-1} tone="bad" />)).toContain('#9c2f2f');
    expect(render(<MoneyText cents={1} tone="good" />)).toContain('#3e7d3e');
  });

  it('color 整体着色:符号/整数/小数三段的色值由调用方给定,单位段仍为三级灰', () => {
    const html = render(<MoneyText cents={-123456789} color="#1664ff" />);
    expect(html).toContain('color:#1664ff');
    expect(html).not.toContain('var(--bd-text-secondary)');
    expect(html).toContain('--bd-text-tertiary');
  });

  it('tone 同时作用于符号、整数与小数段,避免一个数字里出现两种色', () => {
    const html = render(<MoneyText cents={-123456789} showSign tone="bad" />);
    expect(html).toContain('#9c2f2f');
    expect(html).not.toContain('var(--bd-text-secondary)');
  });
});

describe('MoneyText 大额与边界', () => {
  it('大额千分位与负数正确分档', () => {
    // 1_234_567_890_000 分 = 1,234,567.89 万元
    expect(text(<MoneyText cents={-1_234_567_890_000} />)).toBe('-1,234,567.89万元');
  });

  it('整万元值仍带两位小数', () => {
    expect(text(<MoneyText cents={WAN} />)).toBe('1.00万元');
  });
});

describe('MoneyText 精确元查看层', () => {
  it('默认悬停给出精确到分的元值(万元显示舍入不影响核对)', () => {
    // 4999 分显示 0.00 万元,但精确值 49.99 元仍可核对
    expect(render(<MoneyText cents={4999} />)).toContain('title="精确值 49.99 元"');
    expect(render(<MoneyText cents={-123_456_789} />)).toContain('title="精确值 -1,234,567.89 元"');
  });

  it('调用方显式 title 优先,不被精确值覆盖', () => {
    expect(render(<MoneyText cents={WAN} title="自定义提示" />)).toContain('title="自定义提示"');
  });
});
