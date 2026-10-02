import { describe, expect, it } from 'vitest';
import { PAGE_CATALOG, PAGE_IDS, matchPage, pagePath, pageVisible } from '../src/contracts/page-catalog';
import { allowedToolsForCapabilities } from '../src/assistant/page-capabilities';
import { navigationCatalog, resolveNavigation } from '../src/assistant/navigation';
import { toolDefinitions } from '../src/assistant/tools';

describe('T-8.1 shared page contract', () => {
  it('resolves every actual route/tab and its dynamic object paths', () => {
    for (const id of PAGE_IDS) {
      const page = PAGE_CATALOG[id];
      const path = page.path.includes(':id') ? pagePath(id, { id: 17 }) : pagePath(id);
      const url = new URL(path, 'https://newfc.local');
      expect(matchPage(url.pathname, url.search), id).toBe(id);
      expect(page.capabilities).toContain(page.defaultCapability);
    }
    expect(matchPage('/budget/17')).toBe('budget_edit');
    expect(matchPage('/projects/17')).toBe('project_profile');
    for (const path of ['/budget/evil', '/budget/17/more', '/projects', '/settings/other', '/unknown']) expect(matchPage(path)).toBeNull();
    expect(matchPage('/data')).toBe('backup');
    expect(matchPage('/data', '?tab=unknown')).toBe('backup');
  });
  it('navigation uses the same routes and labels, including object links', () => {
    expect(resolveNavigation('跳转到编制页面', { budgetVersionId: 17 })).toMatchObject({ path: '/budget/17', label: PAGE_CATALOG.budget_edit.label });
    for (const entry of navigationCatalog()) expect(entry).toMatchObject({ path: pagePath(entry.page), label: PAGE_CATALOG[entry.page].label });
  });
  it('filters domain permission and whole-organization requirements', () => {
    const has = (permission: string) => ['analysis:read', 'tasks:read'].includes(permission);
    expect(pageVisible('analysis', has, false)).toBe(true);
    expect(pageVisible('history', has, false)).toBe(false);
    expect(pageVisible('jobs', has, false)).toBe(true);
    expect(pageVisible('contracts', has, true)).toBe(false);
  });
  it('all advertised capabilities point to existing executable tools', () => {
    const names = new Set(toolDefinitions.map((t) => t.function.name));
    for (const page of Object.values(PAGE_CATALOG)) for (const name of allowedToolsForCapabilities(page.capabilities)) expect(names.has(name), name).toBe(true);
  });
});
