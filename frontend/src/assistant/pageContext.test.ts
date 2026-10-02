/**
 * 前端单元测试(现行 specs/ai.md 页面上下文契约§13.1)。
 *
 * pageContext 目录:
 * - 28 个 pageKey 与 PAGE_LABEL 一一对应;
 * - /data 全部页签映射到独立 pageKey;
 * - /budget/:id 动态路由 → budget_edit;
 * - 未知路由落到 unknown,绝不回退 dashboard。
 */
import { describe, expect, it } from 'vitest';
import { derivePageContext } from '../assistant/pageContext';
import { PAGE_IDS, PAGE_CATALOG } from '@contracts/page-catalog';


describe('pageKey 目录', () => {
  it('全部业务 pageKey,且每个都有中文标签', () => {
    expect(PAGE_IDS.length).toBeGreaterThan(0);
    for (const key of PAGE_IDS) {
      expect(PAGE_CATALOG[key].label, `${key} 缺少 PAGE_LABEL`).toBeTruthy();
    }
  });

  it('DataManage 的 8 个页签分别映射到 8 个 pageKey', () => {
    const expected: Record<string, string> = {
      backup: 'backup',
      calculations: 'calculations',
      imports: 'imports',
      check: 'data_check',
      yearclose: 'yearclose',
      migration: 'migration',
      export: 'data_export',
      logs: 'logs',
    };
    for (const [tab, pageKey] of Object.entries(expected)) {
      expect(derivePageContext('/data', `?tab=${tab}`).page, tab).toBe(pageKey);
    }
    // 缺省页签 = backup
    expect(derivePageContext('/data', '').page).toBe('backup');
  });

  it('/budget/:id 动态路由只识别为 budget_edit', () => {
    const result = derivePageContext('/budget/42', '');
    expect(result.page).toBe('budget_edit');
    expect(result).not.toHaveProperty('context');
  });

  it('/budget 列表页识别为 budget_versions', () => {
    expect(derivePageContext('/budget', '').page).toBe('budget_versions');
  });

  it('未知路由落到 unknown,绝不冒充 dashboard(§7.1)', () => {
    expect(derivePageContext('/no-such-page', '').page).toBe('unknown');
    expect(derivePageContext('/settings/other', '').page).toBe('unknown');
  });

  it('analysis URL 不生成发送范围', () => {
    const result = derivePageContext('/analysis', '?year=2026&version=3&forecast=4&batch=7&org=11&account=21');
    expect(result.page).toBe('analysis');
    expect(result).not.toHaveProperty('context');
  });

  it('全部 28 个路由都有非 unknown 的页面身份', () => {
    const routes: [string, string][] = [
      ['/eas', ''], ['/governance', ''], ['/statements', ''], ['/mgmt', ''], ['/standard-reports', ''],
      ['/project-budget', ''], ['/plan', ''], ['/contracts', ''], ['/contracts/import', ''], ['/expense', ''], ['/expense/policies', ''],
      ['/feasibility', ''], ['/investment-control', ''], ['/forecast', ''], ['/risk', ''], ['/analysis-reports', ''],
      ['/master-entities', ''], ['/projects/1', ''], ['/search', ''], ['/jobs', ''], ['/settings/business', ''], ['/settings/security', ''],
      ['/', ''], ['/assistant', ''], ['/insights', ''], ['/master-health', ''], ['/cleaning-config', ''],
      ['/progress', ''], ['/alerts', ''], ['/metric-trend', ''], ['/settings/ai', ''],
      ['/org', ''], ['/account', ''], ['/metric', ''], ['/budget', ''], ['/budget/1', ''],
      ['/actual', ''], ['/finance', ''], ['/analysis', ''], ['/structure', ''], ['/history', ''],
      ['/compare', ''],
      ['/data', '?tab=calculations'], ['/data', '?tab=imports'], ['/data', '?tab=check'],
      ['/data', '?tab=yearclose'], ['/data', '?tab=backup'], ['/data', '?tab=migration'],
      ['/data', '?tab=export'], ['/data', '?tab=logs'],
    ];
    expect(routes.length).toBe(50);
    const pages = new Set(routes.map(([pathname, search]) => derivePageContext(pathname, search).page));
    expect(pages.has('unknown')).toBe(false);
    expect(pages.size).toBe(50);
    for (const key of pages) expect(PAGE_IDS).toContain(key);
  });
});
