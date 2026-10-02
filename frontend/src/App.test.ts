import { matchPage, PAGE_CATALOG } from '@contracts/page-catalog';
const permissionFor = (path: string) => { const url = new URL(path, 'https://newfc.local'); const page = matchPage(url.pathname, url.search); return page && PAGE_CATALOG[page].permission; };
/**
 * 侧栏导航扩展计划 阶段一验收:5 个新叶子项的 selectedKey 白名单、
 * dataMenuKey 归并(导入批次/一致性检查恢复为独立入口)与 pageTitle 特判。
 */
import { describe, expect, it } from 'vitest';
import { canAccessPreferencePath, dataMenuKey, filterMenuByPermission, groupOf, menuItems, pageTitle, selectedKey } from './App';
import { setSession } from './api/client';

describe('侧栏高亮与归并(阶段一)', () => {
  it('新增叶子项均在 selectedKey 白名单内', () => {
    expect(selectedKey('/insights', '')).toBe('/insights');
    expect(selectedKey('/master-health', '')).toBe('/master-health');
    expect(selectedKey('/cleaning-config', '')).toBe('/cleaning-config');
    expect(selectedKey('/progress', '')).toBe('/progress');
    expect(selectedKey('/alerts', '')).toBe('/alerts');
    expect(selectedKey('/metric-trend', '')).toBe('/metric-trend');
    expect(selectedKey('/settings/ai', '')).toBe('/settings/ai');
    expect(selectedKey('/settings/security', '')).toBe('/settings/security');
    expect(selectedKey('/settings/business', '')).toBe('/settings/business');
    expect(selectedKey('/master-entities', '')).toBe('/master-entities');
    expect(selectedKey('/projects/12', '')).toBe('/master-entities');
    expect(selectedKey('/jobs', '')).toBe('/jobs');
    // 既有行为不变
    expect(selectedKey('/assistant', '')).toBe('/assistant');
    expect(selectedKey('/budget', '')).toBe('/budget');
    expect(selectedKey('/nope', '')).toBe('/');
  });

  it('dataMenuKey:导入批次/一致性检查映射到自身,测算模板仍归并到宿主页', () => {
    expect(dataMenuKey('imports')).toBe('/data?tab=imports');
    expect(dataMenuKey('check')).toBe('/data?tab=check');
    expect(dataMenuKey('calculations')).toBe('/budget');
    expect(dataMenuKey('yearclose')).toBe('/data?tab=yearclose');
    expect(dataMenuKey('logs')).toBe('/data?tab=logs');
    expect(dataMenuKey(null)).toBe('/data?tab=backup');
    expect(selectedKey('/data', '?tab=imports')).toBe('/data?tab=imports');
    expect(selectedKey('/data', '?tab=check')).toBe('/data?tab=check');
    expect(selectedKey('/data', '?tab=backup')).toBe('/data?tab=backup');
  });

  it('pageTitle:/data?tab= 特判与既有页签', () => {
    expect(pageTitle('/data', '?tab=check', '/data?tab=check')).toBe('一致性检查');
    expect(pageTitle('/data', '?tab=imports', '/data?tab=imports')).toBe('导入批次');
    expect(pageTitle('/data', '?tab=calculations', '/budget')).toBe('测算模板');
    expect(pageTitle('/progress', '', '/progress')).toBe('编制进度');
    expect(pageTitle('/alerts', '', '/alerts')).toBe('异常预警中心');
    expect(pageTitle('/metric-trend', '', '/metric-trend')).toBe('指标趋势');
    expect(pageTitle('/insights', '', '/insights')).toBe('洞察报告');
    expect(pageTitle('/master-health', '', '/master-health')).toBe('主数据健康');
    expect(pageTitle('/cleaning-config', '', '/cleaning-config')).toBe('清洗配置');
    expect(pageTitle('/settings/ai', '', '/settings/ai')).toBe('AI 渠道设置');
  });
});

describe('侧栏按权限裁剪(AC-X04)', () => {
  const items = [
    { key: '/', label: '首页' },
    { key: 'grp-master', label: '主数据', children: [{ key: '/org', label: '组织' }, { key: '/master-entities', label: '项目' }] },
    { key: 'grp-system', label: '系统', children: [{ key: '/jobs', label: '任务中心' }, { key: '/settings/security', label: '用户与权限' }] },
    { key: 'grp-sec', label: '仅管理', children: [{ key: '/settings/ai', label: 'AI' }] },
  ];
  const keys = (list: ReturnType<typeof filterMenuByPermission>): string[] =>
    (list ?? []).flatMap((i) => (i && 'children' in i && i.children ? [String(i.key), ...keys(i.children)] : [String(i?.key)]));

  it('去掉无权限叶子,子项全空的分组一并去掉;未登记入口始终可见', () => {
    const viewer = new Set(['dashboard:read', 'master:read']);
    expect(keys(filterMenuByPermission(items, (p) => viewer.has(p)))).toEqual(['/', 'grp-master', '/org', '/master-entities']);
    expect(keys(filterMenuByPermission(items, () => false))).toEqual([]);
  });

  it('只授权部分组织的账号不展示集团口径入口,按范围裁剪的分析页照常展示', () => {
    const list = [
      { key: 'grp-budget', label: '预算', children: [{ key: '/budget', label: '编制' }, { key: '/progress', label: '进度' }] },
      { key: 'grp-analysis', label: '分析', children: [{ key: '/analysis', label: '执行' }, { key: '/history', label: '历年' }] },
    ];
    const all = () => true;
    expect(keys(filterMenuByPermission(list, all, false))).toEqual(['grp-analysis', '/analysis']);
    expect(keys(filterMenuByPermission(list, all, true))).toEqual(['grp-budget', '/budget', '/progress', 'grp-analysis', '/analysis', '/history']);
  });
});

describe('T-5 投资与预测、风险与报告入口', () => {
  it('新叶子项高亮、标题与权限', () => {
    for (const [key, title, perm] of [
      ['/feasibility', '可行性测算', 'investment:read'], ['/investment-control', '投资控制', 'investment:read'], ['/forecast', '财务预测', 'forecast:read'],
      ['/risk', '风险台账', 'risk:read'], ['/analysis-reports', '分析报告', 'report:read'],
    ] as const) {
      expect(selectedKey(key, '?status=open')).toBe(key);
      expect(pageTitle(key, '', key)).toBe(title);
      expect(permissionFor(key)).toBe(perm);
    }
  });
});

describe('T-6 跨域检索入口', () => {
  it('/search 有独立标题,不高亮任何业务菜单', () => {
    expect(pageTitle('/search', '?q=水厂', selectedKey('/search', '?q=水厂'))).toBe('跨域检索');
    expect(selectedKey('/search', '')).toBe('/search');
  });
});

describe('独立项目领域导航', () => {
  it('收藏/最近访问按当前权限和组织范围裁剪,未知路径不冒充首页', () => {
    try {
      setSession({ authenticated: true, csrfToken: 't', expiresAt: '', user: { id: 1, username: 'analyst', displayName: '分析员', permissions: ['dashboard:read', 'budget:read', 'analysis:read'], allOrgs: false, orgIds: [3], mustChangePassword: false } });
      expect(canAccessPreferencePath('/analysis?year=2026')).toBe(true);
      expect(canAccessPreferencePath('/budget')).toBe(false);
      expect(canAccessPreferencePath('/actual')).toBe(false);
      expect(canAccessPreferencePath('/history')).toBe(false);
      expect(canAccessPreferencePath('/jobs')).toBe(false);
      expect(canAccessPreferencePath('/no-such-page')).toBe(false);
      expect(canAccessPreferencePath('//other.example/analysis')).toBe(false);
    } finally {
      setSession(null);
    }
  });
  it('经营预算集中在一个一级栏目,保留全部既有入口、标题和权限', () => {
    const expected = ['/budget', '/progress', '/actual', '/data?tab=imports', '/cleaning-config', '/finance', '/analysis', '/alerts', '/structure', '/metric-trend', '/history', '/compare'];
    const budget = menuItems?.find((item) => item?.key === 'grp-budget');
    expect(budget && 'children' in budget && budget.children?.map((item) => item?.key)).toEqual(expected);
    for (const key of expected) {
      expect(groupOf(key)).toBe('grp-budget');
      expect(permissionFor(key)).toBeTruthy();
      expect(pageTitle(key.split('?')[0], key.includes('?') ? `?${key.split('?')[1]}` : '', key)).toBeTruthy();
    }
    expect(menuItems?.some((item) => ['grp-plan', 'grp-actual', 'grp-analysis'].includes(String(item?.key)))).toBe(false);
    expect(groupOf('/')).toBeUndefined();
    expect(groupOf('/search')).toBeUndefined();
    expect(groupOf('/contracts')).toBe('grp-project');
    expect(groupOf('/eas')).toBe('grp-finance');
  });

  it('合并后仍按权限与组织范围裁剪经营预算叶子', () => {
    const filtered = filterMenuByPermission(menuItems, (p) => p === 'analysis:read', false);
    const budget = filtered?.find((item) => item?.key === 'grp-budget');
    expect(budget && 'children' in budget && budget.children?.map((item) => item?.key)).toEqual(['/analysis', '/alerts', '/structure', '/metric-trend']);
  });
});
