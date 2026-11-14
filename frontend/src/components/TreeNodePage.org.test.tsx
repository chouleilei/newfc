// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AssistantProvider } from '../assistant/AssistantProvider';
import { TreeManage } from './TreeNodePage';
import { api, setSession } from '../api/client';

beforeEach(() => {
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => computedStyle(element));
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  setSession(null);
  vi.restoreAllMocks();
});

function setAdminSession() {
  setSession({
    authenticated: true,
    csrfToken: 'csrf-t13',
    expiresAt: '',
    user: {
      id: 1,
      username: 'admin',
      displayName: '系统管理员',
      permissions: ['master:read', 'master:write'],
      allOrgs: true,
      orgIds: [],
      mustChangePassword: false,
    },
  });
}

const MOCK_ORG_TREE = {
  tree: [
    {
      id: 1,
      parentId: null,
      code: 'ORG_HQ',
      name: '示范集团本部',
      orgKind: 'legal_entity',
      creditCode: '91000000000000001A',
      planIssuanceRootId: null,
      isPlanExcluded: false,
      contractPrefixCode: 'HQ',
      isDirectStation: false,
      reportFullName: '示范集团有限责任公司',
      sortOrder: 1,
      status: 'active',
      path: '示范集团本部',
      isLeaf: false,
      children: [
        {
          id: 2,
          parentId: 1,
          code: 'ORG_STA',
          name: '甲号直属电站',
          orgKind: 'direct_unit',
          creditCode: '',
          planIssuanceRootId: 1,
          isPlanExcluded: false,
          contractPrefixCode: 'STA',
          isDirectStation: true,
          reportFullName: '示范集团甲号水电站',
          sortOrder: 10,
          status: 'active',
          path: '示范集团本部 / 甲号直属电站',
          isLeaf: true,
          children: [],
        },
        {
          id: 3,
          parentId: 1,
          code: 'ORG_BR',
          name: '乙号直属分公司',
          orgKind: 'direct_unit',
          creditCode: '',
          planIssuanceRootId: 1,
          isPlanExcluded: true,
          contractPrefixCode: 'BR',
          isDirectStation: false,
          reportFullName: '示范集团乙号分公司',
          sortOrder: 20,
          status: 'active',
          path: '示范集团本部 / 乙号直属分公司',
          isLeaf: true,
          children: [],
        },
      ],
    },
  ],
  rows: [
    { id: 1, parent_id: null, code: 'ORG_HQ', name: '示范集团本部', org_kind: 'legal_entity', sort_order: 1, status: 'active', updated_at: '2026-11-01T00:00:00Z' },
    { id: 2, parent_id: 1, code: 'ORG_STA', name: '甲号直属电站', org_kind: 'direct_unit', sort_order: 10, status: 'active', updated_at: '2026-11-01T00:00:00Z' },
    { id: 3, parent_id: 1, code: 'ORG_BR', name: '乙号直属分公司', org_kind: 'direct_unit', sort_order: 20, status: 'active', updated_at: '2026-11-01T00:00:00Z' },
  ],
  externalBlockedPatterns: {
    prefixes: ['EXTP'],
    names: ['外部非并表测试方'],
  },
};

function renderTree(kind: 'org' | 'account') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
      <AntdApp>
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={[`/${kind}`]}>
            <AssistantProvider>
              <TreeManage kind={kind} checkPath={`/${kind}/check`} />
            </AssistantProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </AntdApp>
    </ConfigProvider>,
  );
}

describe('F-GAP-01 TreeNodePage 组织树分类属性与外部实体配置化拦截', () => {
  it('准确区分渲染 direct_unit 与 isDirectStation 标签，创建表单序列化扩展属性并拦截外部非并表主体', { timeout: 30_000 }, async () => {
    setAdminSession();
    vi.spyOn(api, 'get').mockResolvedValue(MOCK_ORG_TREE as never);
    const postSpy = vi.spyOn(api, 'post').mockResolvedValue({ id: 99 } as never);

    renderTree('org');
    await waitFor(() => expect(screen.getByText('甲号直属电站')).toBeTruthy());

    // 区分直属非法人 vs 直属电站 vs 不单列计划
    expect(screen.getAllByText('直属非法人').length).toBe(2);
    expect(screen.getAllByText('直属电站').length).toBe(1);
    expect(screen.getAllByText('不单列计划').length).toBe(1);
    expect(screen.getByText('STA')).toBeTruthy();

    // 打开新建弹窗，先测试外部非并表主体拦截
    fireEvent.click(screen.getByText('新增根节点'));
    await waitFor(() => expect(screen.getByText('主体分类')).toBeTruthy());

    const codeInput = screen.getByPlaceholderText('如 ORG001 / I01');
    const modalDialog = document.querySelector('.ant-modal-content')!;
    const nameInput = modalDialog.querySelector('#name') as HTMLInputElement;
    fireEvent.change(codeInput, { target: { value: 'ORG_NEW_SUB' } });
    fireEvent.change(nameInput, { target: { value: '外部非并表测试方有限公司' } });
    fireEvent.click(modalDialog.querySelector('.ant-modal-footer .ant-btn-primary')!);

    await waitFor(() => {
      expect(screen.getAllByText(/外部合作方\/非并表参考主体严禁录入组织树/).length).toBeGreaterThan(0);
    });
    expect(postSpy).not.toHaveBeenCalled();

    // 改为合法内部法人名称并填写扩展属性提交
    fireEvent.change(nameInput, { target: { value: '示范二级法人公司' } });
    fireEvent.change(screen.getByPlaceholderText('可选，18位统一社会信用代码'), {
      target: { value: '91000000000000009b' },
    });
    fireEvent.change(screen.getByPlaceholderText('用于监管报送与标准公文的单位全称'), {
      target: { value: '示范集团二级法人有限责任公司' },
    });
    fireEvent.change(screen.getByPlaceholderText(/规范大写字母简码/), {
      target: { value: 'sub2' },
    });
    fireEvent.click(screen.getByText('不生成独立年度综合计划下达通知，仅参与集团合并'));
    fireEvent.click(modalDialog.querySelector('.ant-modal-footer .ant-btn-primary')!);

    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
    expect(postSpy).toHaveBeenCalledWith('/org', {
      parentId: null,
      code: 'ORG_NEW_SUB',
      name: '示范二级法人公司',
      sortOrder: 0,
      orgKind: 'legal_entity',
      creditCode: '91000000000000009B',
      reportFullName: '示范集团二级法人有限责任公司',
      planIssuanceRootId: null,
      contractPrefixCode: 'SUB2',
      isPlanExcluded: true,
      isDirectStation: false,
    });
  });

  it('kind="account" 时不出现组织树专有分类属性与批量导入按钮', async () => {
    setAdminSession();
    vi.spyOn(api, 'get').mockResolvedValue({
      tree: [{ id: 10, parentId: null, code: 'I01', name: '营业收入', type: 'income', sortOrder: 1, status: 'active', path: '营业收入', isLeaf: true, children: [] }],
      rows: [{ id: 10, parent_id: null, code: 'I01', name: '营业收入', type: 'income', sort_order: 1, status: 'active', updated_at: '2026-11-01T00:00:00Z' }],
    } as never);

    renderTree('account');
    await waitFor(() => expect(screen.getAllByText('营业收入').length).toBeGreaterThan(0));
    expect(screen.queryByText('批量导入组织')).toBeNull();

    fireEvent.click(screen.getByText('新增根节点'));
    await waitFor(() => expect(screen.getByText('科目类型')).toBeTruthy());
    expect(screen.queryByText('主体分类')).toBeNull();
    expect(screen.queryByText('统一社会信用代码')).toBeNull();
  });
});
