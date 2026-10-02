import { type Page } from '@playwright/test';
import { expect, test, login } from './access';

/**
 * 侧栏叶子菜单项:分组的 submenu-title aria role 也是 menuitem,且折叠分组会用隐藏菜单
 * 复制同名叶子项,因此按「可见的叶子 li + 精确文案」双条件定位。
 */
const leafItem = (page: Page, name: string) =>
  page.locator('li.ant-menu-item[role="menuitem"]:visible', { hasText: name })
    .filter({ has: page.locator('.ant-menu-title-content', { hasText: name }) }).first();

/**
 * 侧栏导航扩展计划(2026-09)主流程回归:
 * 登录 → 各新菜单项可达且高亮正确 → /data?tab=check、/data?tab=imports 深链直达,
 * 确认菜单四同步(menuItems/selectedKey 白名单/dataMenuKey·pageTitle/路由)无回归。
 */
test('侧栏新菜单项可达、高亮正确,深链直达一致', async ({ page }) => {
  await login(page);

  /** 侧栏叶子项点击后应:URL 到达目标路由、该项呈现 antd 选中态、顶栏标题同步。 */
  const leaves: { menu: string; url: RegExp; title: string; marker?: string }[] = [
    { menu: '洞察报告', url: /\/insights$/, title: '洞察报告', marker: '新建洞察' },
    { menu: '进度总览', url: /\/progress$/, title: '进度总览' },
    { menu: '导入批次', url: /\/data\?tab=imports$/, title: '导入批次' },
    { menu: '清洗模板与别名', url: /\/cleaning-config$/, title: '清洗模板与别名', marker: '目标数据集' },
    { menu: '预警中心', url: /\/alerts$/, title: '预警中心', marker: '完成率偏离阈值' },
    { menu: '指标趋势', url: /\/metric-trend$/, title: '指标趋势' },
    { menu: '健康体检', url: /\/master-health$/, title: '健康体检' },
    { menu: '一致性检查', url: /\/data\?tab=check$/, title: '一致性检查' },
    { menu: 'AI 渠道设置', url: /\/settings\/ai$/, title: 'AI 渠道设置', marker: '功能绑定' },
  ];

  for (const leaf of leaves) {
    // 侧栏一次只展开一个分组,仅打开目标叶子所属栏目。
    const groupName = leaf.menu === '洞察报告' ? '财务助手'
      : leaf.menu === '健康体检' ? '主数据'
      : ['一致性检查', 'AI 渠道设置'].includes(leaf.menu) ? '系统' : '经营预算';
    for (const group of [groupName]) {
      const title = page.locator('.ant-menu-submenu-title', { hasText: group });
      if (await title.count() > 0) {
        const expanded = await title.first().getAttribute('aria-expanded');
        if (expanded === 'false') await title.first().click();
      }
    }
    await leafItem(page, leaf.menu).click();
    await expect(page).toHaveURL(leaf.url);
    // 高亮:antd 选中态落在被点击的叶子 menuitem 上
    await expect(leafItem(page, leaf.menu)).toHaveClass(/ant-menu-item-selected/);
    // 顶栏标题同步(pageTitle 特判与 leafLabel 都要对)
    await expect(page.locator('.newfc-header').getByText(leaf.title, { exact: true })).toBeVisible();
    if (leaf.marker) {
      await expect(page.getByText(leaf.marker, { exact: false }).first()).toBeVisible();
    }
  }

  // 深链直达:书签打开 /data?tab=check 与 /data?tab=imports,页面与菜单高亮一致
  await page.goto('/data?tab=check');
  await expect(leafItem(page, '一致性检查')).toHaveClass(/ant-menu-item-selected/);
  await expect(page.locator('.newfc-header').getByText('一致性检查', { exact: true })).toBeVisible();
  // 备份页不再显示一致性检查页签( preset 拆分)
  await page.goto('/data?tab=backup');
  await expect(page.getByRole('tab', { name: '一致性检查' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '备份恢复' })).toBeVisible();

  await page.goto('/data?tab=imports');
  await expect(leafItem(page, '导入批次')).toHaveClass(/ant-menu-item-selected/);
  await expect(page.locator('.newfc-header').getByText('导入批次', { exact: true })).toBeVisible();

  // 既有深链行为不变:测算模板仍归并到「预算与预测」高亮
  await page.goto('/data?tab=calculations');
  await expect(leafItem(page, '预算与预测')).toHaveClass(/ant-menu-item-selected/);
  await expect(page.locator('.newfc-header').getByText('测算模板', { exact: true })).toBeVisible();

  // 既有顶级入口回归:首页与财务助手对话页(grp-ai 分组内的「对话」叶子)
  await leafItem(page, '首页').click();
  await expect(page).toHaveURL(/\/$/);
  const aiGroup = page.locator('.ant-menu-submenu-title', { hasText: '财务助手' });
  if ((await aiGroup.first().getAttribute('aria-expanded')) === 'false') await aiGroup.first().click();
  await leafItem(page, '对话').click();
  await expect(page).toHaveURL(/\/assistant$/);
  await expect(leafItem(page, '对话')).toHaveClass(/ant-menu-item-selected/);
});
