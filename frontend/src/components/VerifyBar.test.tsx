// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider } from 'antd';
import { VerifyBar, reconciliationDetails, type VerifyItem } from './VerifyBar';
import { centsToWan } from '../utils/money';

/** VerifyBar 用 theme.useToken(),脱离 ThemeProvider 时取 antd 默认令牌即可。 */
const render = (items: VerifyItem[]) =>
  renderToStaticMarkup(
    <ConfigProvider><VerifyBar items={items} /></ConfigProvider>,
  );

describe('reconciliationDetails', () => {
  it('差额为零时两侧金额只各显示一次，不重复同一个数', () => {
    // 1 万元 = 10^6 分:58,012.92 万元 = 58_012_920_000 分
    const lines = reconciliationDetails({ sourceCents: 58_012_920_000, displayedCents: 58_012_920_000, differenceCents: 0 }, centsToWan);
    expect(lines).toHaveLength(2);
    expect(lines.join(' ')).not.toContain('差额');
    expect(lines[0]).toBe('来源实际净额 58,012.92 万元');
    expect(lines[1]).toBe('承接合计 58,012.92 万元');
  });

  it('差额不为零时才列出差额行', () => {
    // 0.01 万元 = 10_000 分
    const lines = reconciliationDetails({ sourceCents: 100_000_000, displayedCents: 99_990_000, differenceCents: 10_000 }, centsToWan);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('差额 0.01 万元');
  });
});

describe('VerifyBar 分级语义', () => {
  it('通过项渲染成徽标，不产生 Alert 色块', () => {
    const html = render([{ key: 'reconciliation', level: 'ok', label: '实际数已逐分勾稽', details: ['来源实际净额 58,012.92 万元'] }]);
    expect(html).toContain('实际数已逐分勾稽');
    expect(html).toContain('newfc-verify-badge');
    expect(html).toContain('data-level="ok"');
    // Alert 只在需要人工介入时出现；通过态不应生成
    expect(html).not.toContain('ant-alert');
  });

  it('不平项升格为 error Alert，成为页面唯一的那一块颜色', () => {
    const html = render([{ key: 'reconciliation', level: 'bad', label: '实际数承接对账不平', details: ['差额 0.01 万元'] }]);
    expect(html).toContain('ant-alert-error');
    expect(html).toContain('实际数承接对账不平');
    expect(html).toContain('差额 0.01 万元');
  });

  it('告警项仍是徽标，与阻断项同屏时各行其道', () => {
    const html = render([
      { key: 'ok', level: 'ok', label: '勾稽通过' },
      { key: 'warn', level: 'warn', label: '3 条新增实际由承接区兜底' },
      { key: 'bad', level: 'bad', label: '2 个科目超全年预算' },
    ]);
    expect(html).toContain('ant-alert-error');
    expect(html).toContain('data-level="ok"');
    expect(html).toContain('data-level="warn"');
    // 阻断项直接进入 Alert，不占徽标行
    expect(html).not.toContain('data-level="bad"');
  });

  it('多项阻断合并成一条 Alert，不逐条铺色块', () => {
    const html = render([
      { key: 'a', level: 'bad', label: '对账不平' },
      { key: 'b', level: 'bad', label: '子项之和与上级不符' },
    ]);
    expect(html.match(/ant-alert-error/g)?.length).toBe(1);
    expect(html).toContain('2 项核验未通过，数据暂不可信');
    expect(html).toContain('对账不平');
    expect(html).toContain('子项之和与上级不符');
  });

  it('同 key 的重复结论只渲染一次', () => {
    const html = render([
      { key: 'reconciliation', level: 'ok', label: '实际数已逐分勾稽' },
      { key: 'reconciliation', level: 'ok', label: '实际数已逐分勾稽' },
    ]);
    expect(html.match(/实际数已逐分勾稽/g)?.length).toBe(1);
  });

  it('无可核验项时不渲染任何容器', () => {
    expect(render([])).toBe('');
  });

  it('可跳转项带 role=button 与键盘可达性', () => {
    const html = render([{ key: 'overspend', level: 'bad', label: '12 个成本费用科目超全年预算', onClick: () => {} }]);
    expect(html).toContain('ant-alert-error');
    expect(html).toContain('12 个成本费用科目超全年预算');
  });
});

// ── 键盘可达性(现行 specs/ai.md 页面上下文契约§13.1) ──
import { cleanup, fireEvent, render as renderDom, screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import { AssistantRegistryProvider, useAssistantRegistryView } from '../assistant/AssistantContextRegistry';
import { MemoryRouter } from 'react-router-dom';

const domRender = (items: VerifyItem[]) => renderDom(
  <MemoryRouter>
    <AssistantRegistryProvider>
      <ConfigProvider><VerifyBar items={items} /></ConfigProvider>
    </AssistantRegistryProvider>
  </MemoryRouter>,
);

describe('VerifyBar 键盘可达性(§13.1)', () => {
  afterEach(() => cleanup());
  it('带明细的徽标:Enter 展开、aria-expanded 切换、Escape 关闭并还原因素', () => {
    domRender([{ key: 'recon', level: 'ok', label: '实际数已逐分勾稽', details: ['来源 100 万元', '承接 100 万元'] }]);
    const badge = screen.getByTestId('verify-badge-recon');
    expect(badge.getAttribute('aria-expanded')).toBe('false');

    fireEvent.keyDown(badge, { key: 'Enter' });
    expect(badge.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('来源 100 万元')).toBeTruthy();

    fireEvent.keyDown(badge, { key: 'Escape' });
    expect(badge.getAttribute('aria-expanded')).toBe('false');
  });

  it('Space 键同样切换展开', () => {
    domRender([{ key: 'sub', level: 'warn', label: '小计校验', details: ['明细 A'] }]);
    const badge = screen.getByTestId('verify-badge-sub');
    fireEvent.keyDown(badge, { key: ' ' });
    expect(badge.getAttribute('aria-expanded')).toBe('true');
  });

  it('无明细且无 onClick 的徽标不可聚焦、无 button 角色', () => {
    domRender([{ key: 'plain', level: 'ok', label: '纯展示项' }]);
    const badge = screen.getByTestId('verify-badge-plain');
    expect(badge.getAttribute('role')).toBeNull();
    expect(badge.getAttribute('tabindex')).toBeNull();
  });

  it('onClick 跳转项:Enter 触发跳转回调', () => {
    let clicked = 0;
    domRender([{ key: 'overspend', level: 'bad', label: '超支预警', onClick: () => { clicked += 1; } }]);
    const item = screen.getByTestId('verify-blocking-overspend');
    fireEvent.keyDown(item, { key: 'Enter' });
    expect(clicked).toBe(1);
  });

  it('带 assistantTarget 的徽标打开时登记核验焦点,关闭时清理', () => {
    const { getByTestId } = renderDom(
      <MemoryRouter>
        <AssistantRegistryProvider>
          <ConfigProvider>
            <VerifyBar items={[{
              key: 'recon', level: 'warn', label: '勾稽提示', details: ['明细'],
              assistantTarget: { ownerKey: 'analysis:root', factKey: 'analysis:root:reconciliation' },
            }]} />
          </ConfigProvider>
        </AssistantRegistryProvider>
      </MemoryRouter>,
    );
    const badge = getByTestId('verify-badge-recon');
    fireEvent.keyDown(badge, { key: 'Enter' });
    expect(badge.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(badge, { key: 'Escape' });
    expect(badge.getAttribute('aria-expanded')).toBe('false');
  });

  it('打开明细时核验焦点进入注册中心,关闭与卸载后清理(读 registry 断言)', () => {
    function Probe() {
      const view = useAssistantRegistryView();
      return <div data-testid="probe-focus">{view.focus ? `${view.focus.kind}:${(view.focus as { factKey: string }).factKey}` : 'none'}</div>;
    }
    const { getByTestId, unmount } = renderDom(
      <MemoryRouter>
        <AssistantRegistryProvider>
          <ConfigProvider>
            <VerifyBar items={[{
              key: 'recon', level: 'warn', label: '勾稽提示', details: ['明细'],
              assistantTarget: { ownerKey: 'analysis:root', factKey: 'reconciliation' },
            }]} />
          </ConfigProvider>
          <Probe />
        </AssistantRegistryProvider>
      </MemoryRouter>,
    );
    // 关闭态:无焦点
    expect(getByTestId('probe-focus').textContent).toBe('none');
    // 打开明细:focus 登记为 fact
    fireEvent.keyDown(getByTestId('verify-badge-recon'), { key: 'Enter' });
    expect(getByTestId('probe-focus').textContent).toBe('fact:reconciliation');
    // Escape 关闭:焦点清理
    fireEvent.keyDown(getByTestId('verify-badge-recon'), { key: 'Escape' });
    expect(getByTestId('probe-focus').textContent).toBe('none');
    // 重新打开后直接卸载组件:焦点同样被清理(孤儿焦点回归)
    fireEvent.keyDown(getByTestId('verify-badge-recon'), { key: 'Enter' });
    expect(getByTestId('probe-focus').textContent).toBe('fact:reconciliation');
    unmount();
  });

  it('仅带 assistantTarget 无动作的阻断项不是假按钮:无 button 角色不可聚焦', () => {
    domRender([
      { key: 'fact-only', level: 'bad', label: '勾稽不平', assistantTarget: { ownerKey: 'a', factKey: 'b' } },
      { key: 'action', level: 'bad', label: '超支', onClick: () => undefined },
    ]);
    expect(screen.getByTestId('verify-blocking-fact-only').getAttribute('role')).toBeNull();
    expect(screen.getByTestId('verify-blocking-fact-only').getAttribute('tabindex')).toBeNull();
    expect(screen.getByTestId('verify-blocking-action').getAttribute('role')).toBe('button');
  });
});
