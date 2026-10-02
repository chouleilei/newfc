/**
 * 个人偏好 React 入口(UX-25):UserPrefsProvider 挂在 App 壳层(按服务端用户 ID 命名空间),
 * 页面经 useUserPrefs 读写。单一 Provider 实例按 ref 做读-改-写,避免多处并发覆盖;
 * StrictMode 下 setState updater 不携带副作用,持久化在 updater 外完成;
 * 写操作经 useCallback 固定身份(实现读 ref,不依赖渲染快照),
 * 以便「导航时记录最近访问」这类 effect 不会因回调身份变化而反复触发。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PageId } from '@contracts/page-catalog';

import {
  addSavedView,
  deleteSavedView,
  emptyUserPrefs,
  findFavorite,
  loadUserPrefs,
  recordRecentPage,
  removeFavorite,
  renameSavedView,
  resetUserPrefs,
  saveUserPrefs,
  toggleFavorite,
  type FavoriteEntry,
  type SavedViewEntry,
  type UserPrefs,
} from '../utils/userPrefs';

export interface UserPrefsApi {
  prefs: UserPrefs;
  /** 某路由已保存的命名视图(按创建时间升序)。 */
  savedViewsFor: (pageKey: PageId) => SavedViewEntry[];
  /** 保存命名视图;返回 null 表示拒绝(名称为空/路由不支持/已达上限)。 */
  saveView: (input: { name: string; pageKey: PageId; search: string }) => SavedViewEntry | null;
  renameView: (id: string, name: string) => void;
  deleteView: (id: string) => void;
  /** 当前 路由+路径 是否已收藏(返回收藏项便于取 id)。 */
  favoriteFor: (pageKey: PageId, path: string) => FavoriteEntry | undefined;
  /** 切换收藏;返回操作后是否处于已收藏(超上限/不支持时返回 false 且不变更)。 */
  toggleFavoriteEntry: (input: { pageKey: PageId; path: string; label: string }) => boolean;
  removeFavoriteEntry: (id: string) => void;
  recordRecent: (input: { pageKey: PageId; path: string; label: string }) => void;
  /** 清空本账号全部偏好(视图/收藏/最近),不影响任何业务数据。 */
  resetPrefs: () => void;
}

const UserPrefsContext = createContext<UserPrefsApi | null>(null);

function storageOrNull(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function UserPrefsProvider({ namespace, children, canAccessPath }: { namespace: string; children: ReactNode; canAccessPath?: (path: string) => boolean }) {
  const [prefs, setPrefs] = useState<UserPrefs>(() => {
    const storage = storageOrNull();
    return storage ? loadUserPrefs(storage, namespace) : emptyUserPrefs();
  });
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  /* 账号切换(命名空间变化)时重新载入对应偏好 */
  useEffect(() => {
    const storage = storageOrNull();
    const loaded = storage ? loadUserPrefs(storage, namespace) : emptyUserPrefs();
    prefsRef.current = loaded;
    setPrefs(loaded);
  }, [namespace]);

  const persist = useCallback((next: UserPrefs) => {
    prefsRef.current = next;
    setPrefs(next);
    const storage = storageOrNull();
    if (storage) saveUserPrefs(storage, namespace, next);
  }, [namespace]);

  const saveView = useCallback<UserPrefsApi['saveView']>((input) => {
    const result = addSavedView(prefsRef.current, input, Date.now());
    if (!result) return null;
    persist(result.prefs);
    return result.entry;
  }, [persist]);

  const renameView = useCallback<UserPrefsApi['renameView']>((id, name) => {
    persist(renameSavedView(prefsRef.current, id, name, Date.now()));
  }, [persist]);

  const deleteView = useCallback<UserPrefsApi['deleteView']>((id) => {
    persist(deleteSavedView(prefsRef.current, id));
  }, [persist]);

  const toggleFavoriteEntry = useCallback<UserPrefsApi['toggleFavoriteEntry']>((input) => {
    const result = toggleFavorite(prefsRef.current, input, Date.now());
    persist(result.prefs);
    return result.favorited;
  }, [persist]);

  const removeFavoriteEntry = useCallback<UserPrefsApi['removeFavoriteEntry']>((id) => {
    persist(removeFavorite(prefsRef.current, id));
  }, [persist]);

  const recordRecent = useCallback<UserPrefsApi['recordRecent']>((input) => {
    persist(recordRecentPage(prefsRef.current, input, Date.now()));
  }, [persist]);

  const resetPrefs = useCallback(() => {
    const storage = storageOrNull();
    if (storage) resetUserPrefs(storage, namespace);
    prefsRef.current = emptyUserPrefs();
    setPrefs(emptyUserPrefs());
  }, [namespace]);

  // 授权收窄后不展示失效入口;原偏好保留,重新授权后仍可使用。
  const visiblePrefs = useMemo(() => canAccessPath ? {
    ...prefs,
    favorites: prefs.favorites.filter((item) => canAccessPath(item.path)),
    recents: prefs.recents.filter((item) => canAccessPath(item.path)),
  } : prefs, [prefs, canAccessPath]);

  const savedViewsFor = useCallback<UserPrefsApi['savedViewsFor']>(
    (pageKey) => prefs.savedViews.filter((view) => view.pageKey === pageKey),
    [prefs],
  );
  const favoriteFor = useCallback<UserPrefsApi['favoriteFor']>(
    (pageKey, path) => findFavorite(visiblePrefs, pageKey, path),
    [visiblePrefs],
  );

  const api = useMemo<UserPrefsApi>(() => ({
    prefs: visiblePrefs,
    savedViewsFor,
    saveView,
    renameView,
    deleteView,
    favoriteFor,
    toggleFavoriteEntry,
    removeFavoriteEntry,
    recordRecent,
    resetPrefs,
  }), [visiblePrefs, savedViewsFor, saveView, renameView, deleteView, favoriteFor, toggleFavoriteEntry, removeFavoriteEntry, recordRecent, resetPrefs]);

  return <UserPrefsContext.Provider value={api}>{children}</UserPrefsContext.Provider>;
}

/** 读取偏好 API;必须在 UserPrefsProvider 内(登录壳之外无偏好语义)。 */
export function useUserPrefs(): UserPrefsApi {
  const ctx = useContext(UserPrefsContext);
  if (!ctx) throw new Error('useUserPrefs 必须在 UserPrefsProvider 内使用');
  return ctx;
}
