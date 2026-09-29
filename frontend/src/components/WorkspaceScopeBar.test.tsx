// @vitest-environment jsdom
/**
 * WorkspaceScopeBar(UX-04)单元测试:
 * - 统一渲染「年度 · 组织 · 版本/状态 · 实际截至 · 金额单位」
 * - 待提交截止日与来源日期区分(一致时不重复显示)
 * - loading 状态渲染骨架(切换期间不混显旧范围)
 * - invalid 状态给出失效标识与原因
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider } from 'antd';
import WorkspaceScopeBar from './WorkspaceScopeBar';

const render = (node: React.ReactElement) => renderToStaticMarkup(<ConfigProvider>{node}</ConfigProvider>);
const text = (node: React.ReactElement) => render(node).replace(/<[^>]*>/g, '');

describe('WorkspaceScopeBar', () => {
  it('渲染年度、组织、版本、状态、实际截至与金额单位', () => {
    const output = text(
      <WorkspaceScopeBar
        year={2026}
        orgName="江垭电站"
        versionName="年初预算"
        statusLabel="草稿编制中"
        asOfDate="2026-08-31"
      />,
    );
    expect(output).toContain('2026 年');
    expect(output).toContain('江垭电站');
    expect(output).toContain('年初预算');
    expect(output).toContain('草稿编制中');
    expect(output).toContain('实际截至 2026-08-31');
    expect(output).toContain('万元');
  });

  it('待提交截止日与来源日期不同才显示,并标注为待提交', () => {
    const same = text(<WorkspaceScopeBar year={2026} asOfDate="2026-08-31" pendingDate="2026-08-31" />);
    expect(same).not.toContain('待提交');
    const different = text(<WorkspaceScopeBar year={2026} asOfDate="2026-08-31" pendingDate="2026-09-30" />);
    expect(different).toContain('实际截至 2026-08-31');
    expect(different).toContain('待提交截止 2026-09-30');
  });

  it('loading 状态渲染骨架占位,不渲染任何范围数值', () => {
    const markup = render(<WorkspaceScopeBar year={2025} orgName="旧组织" status="loading" />);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain('旧组织');
    expect(markup).not.toContain('2025');
  });

  it('invalid 状态显示失效标识并携带原因', () => {
    const markup = render(
      <WorkspaceScopeBar year={2026} status="invalid" statusLabel="范围失效" issues={['链接中的组织 99 不存在或已删除']} />,
    );
    expect(markup).toContain('范围已失效');
    expect(markup).toContain('链接中的组织 99 不存在或已删除');
  });

  it('缺省组织显示「全部」,长名称截断但保留全文入口', () => {
    const noOrg = render(<WorkspaceScopeBar year={2026} />);
    expect(noOrg).toContain('全部');
    const longName = render(<WorkspaceScopeBar year={2026} orgName="某超长名称的集团下属区域分公司一号电站" />);
    expect(longName).toContain('某超长名称的集团下属区域分公司一号电站');
    expect(longName).toContain('bd-scope-bar-value');
  });
});
