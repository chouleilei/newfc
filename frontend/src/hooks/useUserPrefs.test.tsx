// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { UserPrefsProvider, useUserPrefs } from './useUserPrefs';
import { emptyUserPrefs, prefsStorageKey, recordRecentPage, toggleFavorite } from '../utils/userPrefs';

afterEach(() => { cleanup(); localStorage.clear(); });

function Probe() {
  const { prefs } = useUserPrefs();
  return <div>{JSON.stringify({ favorites: prefs.favorites.map((f) => f.path), recents: prefs.recents.map((r) => r.path) })}</div>;
}

it('授权收窄隐藏收藏与最近访问,原记录保留且恢复授权后再次显示', () => {
  let prefs = emptyUserPrefs();
  for (const [pageKey, path] of [['budget_versions', '/budget'], ['analysis', '/analysis']] as const) {
    prefs = toggleFavorite(prefs, { pageKey, path, label: path }, 1).prefs;
    prefs = recordRecentPage(prefs, { pageKey, path, label: path }, 1);
  }
  const key = prefsStorageKey('account:1');
  localStorage.setItem(key, JSON.stringify(prefs));
  const original = localStorage.getItem(key);
  const view = render(<UserPrefsProvider namespace="account:1" canAccessPath={(path) => path === '/analysis'}><Probe /></UserPrefsProvider>);
  expect(screen.getByText('{"favorites":["/analysis"],"recents":["/analysis"]}')).toBeTruthy();
  expect(localStorage.getItem(key)).toBe(original);
  view.rerender(<UserPrefsProvider namespace="account:1" canAccessPath={() => true}><Probe /></UserPrefsProvider>);
  expect(screen.getByText((text) => text.startsWith('{"favorites":') && text.includes('/budget'))).toBeTruthy();
  expect(localStorage.getItem(key)).toBe(original);
});
