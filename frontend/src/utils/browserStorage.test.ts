import { describe, expect, it } from 'vitest';
import { readBrowserStorage, removeBrowserStorage } from './browserStorage';
import { emptyUserPrefs, loadUserPrefs, resetUserPrefs, toggleFavorite } from './userPrefs';

function storage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
}

describe('浏览器命名迁移', () => {
  it('同一账号收藏迁入后不丢失，另一账号和旧显示名空间不能读到', () => {
    const s = storage();
    const prefs = toggleFavorite(emptyUserPrefs(), { pageKey: 'analysis', path: '/analysis', label: '年度执行分析' }, 1).prefs;
    s.setItem('bd:prefs:account:11', JSON.stringify(prefs));
    s.setItem('bd:prefs:user-admin', JSON.stringify(prefs));
    expect(loadUserPrefs(s, 'account:12').favorites).toEqual([]);
    expect(loadUserPrefs(s, 'user-admin').favorites).toEqual([]);
    expect(loadUserPrefs(s, 'account:11').favorites).toEqual(prefs.favorites);
    expect(s.getItem('newfc:prefs:account:11')).not.toBeNull();
    expect(s.getItem('bd:prefs:account:11')).toBeNull();
    resetUserPrefs(s, 'account:11');
    expect(loadUserPrefs(s, 'account:11').favorites).toEqual([]);
    expect(s.getItem('bd:prefs:user-admin')).not.toBeNull();
  });

  it('主题、列配置和位置迁移，新键优先，不读取无关键', () => {
    const s = storage();
    for (const [old, next, value] of [
      ['budget-theme-mode', 'newfc-theme-mode', 'dark'],
      ['bd-matrix-cols-budget', 'newfc-matrix-cols-budget', '{"fixed":true}'],
      ['bd:route-pos:k1', 'newfc:route-pos:k1', '{"scrollTop":123}'],
      ['bd-budget-1:gridpos', 'newfc-budget-1:gridpos', '{"rowId":1}'],
    ]) {
      s.setItem(old, value);
      expect(readBrowserStorage(s, next)).toBe(value);
      expect(s.getItem(old)).toBeNull();
    }
    s.setItem('bd-grid-density', '"compact"');
    s.setItem('newfc-grid-density', '"relaxed"');
    expect(readBrowserStorage(s, 'newfc-grid-density')).toBe('"relaxed"');
    s.setItem('bd:prefs:default', 'private');
    expect(readBrowserStorage(s, 'newfc:prefs:default')).toBeNull();
  });

  it('迁移助手入口标签，保留用户自己命名的视图和其他入口', () => {
    const s = storage();
    s.setItem('bd:prefs:account:11', JSON.stringify({
      favorites: [{ label: '小澧助手' }, { label: '我的预算' }],
      recents: [{ label: '小澧助手' }], savedViews: [{ name: '小澧助手' }],
    }));
    expect(JSON.parse(readBrowserStorage(s, 'newfc:prefs:account:11')!)).toEqual({
      favorites: [{ label: '财务助手' }, { label: '我的预算' }],
      recents: [{ label: '财务助手' }], savedViews: [{ name: '小澧助手' }],
    });
  });

  it('配额不足不删除旧数据，重置同时清除兼容键以免再次恢复', () => {
    const s = storage();
    s.setItem('bd:prefs:account:11', '{"schemaVersion":1}');
    s.setItem = () => { throw new Error('quota'); };
    expect(readBrowserStorage(s, 'newfc:prefs:account:11')).toBe('{"schemaVersion":1}');
    expect(s.getItem('bd:prefs:account:11')).not.toBeNull();
    removeBrowserStorage(s, 'newfc:prefs:account:11');
    expect(readBrowserStorage(s, 'newfc:prefs:account:11')).toBeNull();
  });
});
