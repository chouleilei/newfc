/**
 * 个人偏好存储(方案《易用性与直觉化交互实施方案》§4.7 末段/§6.7,任务 UX-25)。
 *
 * 约定:
 * - 内容只包括三类入口偏好:命名分析视图(savedViews)、页面收藏(favorites)、最近访问(recents);
 *   保存的是「入口 + 白名单范围参数」,绝不存金额、文件、草稿内容或确认凭证;
 * - 持久化在 localStorage,键为 `newfc:prefs:<命名空间>`;登录后按服务端用户 ID 隔离
 *   (prefsNamespaceFor),不同账号互不可见,未登录/本机模式落到 default;
 * - schemaVersion 用于将来迁移;版本不符或 JSON 损坏时清空该键并返回空偏好,
 *   页面照常渲染(损坏偏好不阻塞页面);
 * - 所有范围参数写入前经 workspaceScope 白名单规范化;读取时再规范化一次并剔除
 *   非法条目(被降级剔除时写回自愈),因此手改 localStorage 注入的越界参数不会进入页面;
 * - 恢复只是导航:应用视图/收藏/最近访问一律由调用方 navigate,本模块不产生任何提交。
 */
import { readBrowserStorage, removeBrowserStorage } from './browserStorage';
import { isPageKey, type PageKey } from '../assistant/context';
import { isScopeRestorable, normalizeScopeSearch, ROUTE_SCOPE_WHITELIST } from './workspaceScope';

export const PREFS_SCHEMA_VERSION = 1;

const KEY_PREFIX = 'newfc:prefs:';
export const MAX_SAVED_VIEWS = 20;
export const MAX_FAVORITES = 20;
export const MAX_RECENTS = 8;
const MAX_NAME_LENGTH = 40;
const MAX_LABEL_LENGTH = 60;
const MAX_PATH_LENGTH = 512;

/** 命名分析视图:某白名单路由的一组查询参数(不含 ?),附用户起的名字。 */
export interface SavedViewEntry {
  id: string;
  name: string;
  pageKey: PageKey;
  /** 规范化后的查询串(不含 ?);只含该路由白名单参数。 */
  search: string;
  createdAt: number;
  updatedAt: number;
}

/** 页面收藏:稳定的入口路径(含规范化范围)与显示名。 */
export interface FavoriteEntry {
  id: string;
  pageKey: PageKey;
  path: string;
  label: string;
  createdAt: number;
}

/** 最近访问:路由 + 范围 + 时间,新的在前。 */
export interface RecentEntry {
  pageKey: PageKey;
  path: string;
  label: string;
  visitedAt: number;
}

export interface UserPrefs {
  schemaVersion: number;
  savedViews: SavedViewEntry[];
  favorites: FavoriteEntry[];
  recents: RecentEntry[];
}

/** 兼容 localStorage 的最小接口,便于测试注入内存实现(同 routeMemory)。 */
export interface PrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 登录会话用稳定用户 ID;无 ID 的旧调用保留用户名派生逻辑,不自动迁入可能共用的旧偏好。 */
export function prefsNamespaceFor(username: string | null | undefined, userId?: number): string {
  if (userId != null && Number.isSafeInteger(userId) && userId > 0) return `account:${userId}`;
  const clean = (username ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return clean ? `user-${clean}` : 'default';
}

export function prefsStorageKey(namespace: string): string {
  return `${KEY_PREFIX}${namespace}`;
}

export function emptyUserPrefs(): UserPrefs {
  return { schemaVersion: PREFS_SCHEMA_VERSION, savedViews: [], favorites: [], recents: [] };
}

/** /data 的子页身份由 tab 决定;tab 不是范围参数,但必须随入口保留(只认已知页签值)。 */
const DATA_TABS = new Set(['calculations', 'imports', 'check', 'yearclose', 'migration', 'export', 'logs', 'backup']);

/**
 * 受支持页面的规范化入口路径:范围参数按路由白名单重建,其余参数一律丢弃
 * (一次性定位参数、凭证样参数不会进收藏/最近记录);/data 额外保留合法 tab。
 */
export function entryPathFor(pageKey: PageKey, pathname: string, search: string): string {
  const params = new URLSearchParams(normalizeScopeSearch(pageKey, search));
  if (pathname === '/data') {
    const tab = new URLSearchParams(search).get('tab') ?? '';
    if (!DATA_TABS.has(tab)) return '/data';
    const merged = new URLSearchParams();
    merged.set('tab', tab);
    params.forEach((value, key) => merged.set(key, value));
    return `/data?${merged.toString()}`;
  }
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** 该路由是否可作为偏好入口(收录进 PAGE_KEYS 即受支持;视图另要求支持范围)。 */
export function isPrefsSupportedPage(pageKey: string): pageKey is PageKey {
  return isPageKey(pageKey) && pageKey in ROUTE_SCOPE_WHITELIST;
}

function asFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asCleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().slice(0, max);
  return text ? text : null;
}

function sanitizeSavedView(raw: unknown): SavedViewEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const id = asCleanText(item.id, 64);
  const name = asCleanText(item.name, MAX_NAME_LENGTH);
  const pageKey = typeof item.pageKey === 'string' && isScopeRestorable(item.pageKey as PageKey) && isPageKey(item.pageKey) ? item.pageKey : null;
  if (!id || !name || !pageKey || typeof item.search !== 'string' || item.search.length > MAX_PATH_LENGTH) return null;
  return {
    id,
    name,
    pageKey: pageKey as PageKey,
    search: normalizeScopeSearch(pageKey as PageKey, item.search),
    createdAt: asFiniteNumber(item.createdAt),
    updatedAt: asFiniteNumber(item.updatedAt),
  };
}

function splitPath(path: string): { pathname: string; search: string } | null {
  if (!path.startsWith('/') || path.length > MAX_PATH_LENGTH || path.includes('://') || path.includes('..')) return null;
  const qIndex = path.indexOf('?');
  return qIndex < 0
    ? { pathname: path, search: '' }
    : { pathname: path.slice(0, qIndex), search: path.slice(qIndex + 1) };
}

function sanitizeFavorite(raw: unknown): FavoriteEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const id = asCleanText(item.id, 64);
  const label = asCleanText(item.label, MAX_LABEL_LENGTH);
  const pageKey = typeof item.pageKey === 'string' && isPrefsSupportedPage(item.pageKey) ? item.pageKey : null;
  const parts = typeof item.path === 'string' ? splitPath(item.path) : null;
  if (!id || !label || !pageKey || !parts) return null;
  return { id, label, pageKey, path: entryPathFor(pageKey, parts.pathname, parts.search), createdAt: asFiniteNumber(item.createdAt) };
}

function sanitizeRecent(raw: unknown): RecentEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const label = asCleanText(item.label, MAX_LABEL_LENGTH);
  const pageKey = typeof item.pageKey === 'string' && isPrefsSupportedPage(item.pageKey) ? item.pageKey : null;
  const parts = typeof item.path === 'string' ? splitPath(item.path) : null;
  if (!label || !pageKey || !parts) return null;
  return { label, pageKey, path: entryPathFor(pageKey, parts.pathname, parts.search), visitedAt: asFiniteNumber(item.visitedAt) };
}

function sanitizeList<T>(raw: unknown, sanitize: (item: unknown) => T | null, max: number): { list: T[]; dropped: boolean } {
  if (!Array.isArray(raw)) return { list: [], dropped: raw !== undefined };
  const list: T[] = [];
  let dropped = false;
  for (const item of raw) {
    const clean = sanitize(item);
    if (clean) list.push(clean);
    else dropped = true;
  }
  if (list.length > max) {
    list.length = max;
    dropped = true;
  }
  return { list, dropped };
}

/**
 * 读取偏好:键不存在 → 空偏好;JSON 损坏/版本不符 → 删除该键并返回空偏好(自愈,不阻塞);
 * 部分条目非法 → 剔除后写回干净副本。所有异常都被吞掉,本函数绝不抛出。
 */
export function loadUserPrefs(storage: PrefsStorage, namespace: string): UserPrefs {
  let raw: string | null = null;
  try {
    raw = readBrowserStorage(storage, prefsStorageKey(namespace));
  } catch {
    return emptyUserPrefs();
  }
  if (!raw) return emptyUserPrefs();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== PREFS_SCHEMA_VERSION) {
      throw new Error('schema');
    }
  } catch {
    try { removeBrowserStorage(storage, prefsStorageKey(namespace)); } catch { /* 清理失败也按空偏好继续 */ }
    return emptyUserPrefs();
  }
  const views = sanitizeList(parsed.savedViews, sanitizeSavedView, MAX_SAVED_VIEWS);
  const favorites = sanitizeList(parsed.favorites, sanitizeFavorite, MAX_FAVORITES);
  const recents = sanitizeList(parsed.recents, sanitizeRecent, MAX_RECENTS);
  const prefs: UserPrefs = {
    schemaVersion: PREFS_SCHEMA_VERSION,
    savedViews: views.list,
    favorites: favorites.list,
    recents: recents.list,
  };
  if (views.dropped || favorites.dropped || recents.dropped) saveUserPrefs(storage, namespace, prefs);
  return prefs;
}

/** 写入偏好;隐私模式/配额满时静默降级(偏好是增强而非业务正确性)。 */
export function saveUserPrefs(storage: PrefsStorage, namespace: string, prefs: UserPrefs): void {
  try {
    storage.setItem(prefsStorageKey(namespace), JSON.stringify(prefs));
  } catch { /* 见函数注释 */ }
}

/** 重置入口:删除该命名空间全部偏好;只动 `newfc:prefs:` 键,不涉及任何业务数据。 */
export function resetUserPrefs(storage: PrefsStorage, namespace: string): void {
  try {
    removeBrowserStorage(storage, prefsStorageKey(namespace));
  } catch { /* 同上 */ }
}

export type IdGenerator = () => string;

function defaultId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `pref-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 保存命名视图:仅支持带范围白名单的路由;名称去空白并截断。
 * 返回 null 表示拒绝(路由不支持范围/名称为空/已达上限)。
 */
export function addSavedView(
  prefs: UserPrefs,
  input: { name: string; pageKey: PageKey; search: string },
  now: number,
  idGen: IdGenerator = defaultId,
): { prefs: UserPrefs; entry: SavedViewEntry } | null {
  const name = input.name.trim().slice(0, MAX_NAME_LENGTH);
  if (!name || !isScopeRestorable(input.pageKey)) return null;
  if (prefs.savedViews.length >= MAX_SAVED_VIEWS) return null;
  const entry: SavedViewEntry = {
    id: idGen(),
    name,
    pageKey: input.pageKey,
    search: normalizeScopeSearch(input.pageKey, input.search),
    createdAt: now,
    updatedAt: now,
  };
  return { prefs: { ...prefs, savedViews: [...prefs.savedViews, entry] }, entry };
}

export function renameSavedView(prefs: UserPrefs, id: string, name: string, now: number): UserPrefs {
  const clean = name.trim().slice(0, MAX_NAME_LENGTH);
  if (!clean) return prefs;
  if (!prefs.savedViews.some((view) => view.id === id)) return prefs;
  return {
    ...prefs,
    savedViews: prefs.savedViews.map((view) => (view.id === id ? { ...view, name: clean, updatedAt: now } : view)),
  };
}

export function deleteSavedView(prefs: UserPrefs, id: string): UserPrefs {
  if (!prefs.savedViews.some((view) => view.id === id)) return prefs;
  return { ...prefs, savedViews: prefs.savedViews.filter((view) => view.id !== id) };
}

/** 按 路由+规范化路径 查找收藏(同一路径只收藏一次)。 */
export function findFavorite(prefs: UserPrefs, pageKey: PageKey, path: string): FavoriteEntry | undefined {
  return prefs.favorites.find((item) => item.pageKey === pageKey && item.path === path);
}

/** 切换收藏:已收藏则取消;未收藏则新增(超上限返回 favorited=false 且不改动)。 */
export function toggleFavorite(
  prefs: UserPrefs,
  input: { pageKey: PageKey; path: string; label: string },
  now: number,
  idGen: IdGenerator = defaultId,
): { prefs: UserPrefs; favorited: boolean } {
  const existing = findFavorite(prefs, input.pageKey, input.path);
  if (existing) {
    return { prefs: { ...prefs, favorites: prefs.favorites.filter((item) => item.id !== existing.id) }, favorited: false };
  }
  const label = input.label.trim().slice(0, MAX_LABEL_LENGTH) || '未命名页面';
  if (prefs.favorites.length >= MAX_FAVORITES || !isPrefsSupportedPage(input.pageKey)) {
    return { prefs, favorited: false };
  }
  const entry: FavoriteEntry = { id: idGen(), pageKey: input.pageKey, path: input.path, label, createdAt: now };
  return { prefs: { ...prefs, favorites: [...prefs.favorites, entry] }, favorited: true };
}

export function removeFavorite(prefs: UserPrefs, id: string): UserPrefs {
  if (!prefs.favorites.some((item) => item.id === id)) return prefs;
  return { ...prefs, favorites: prefs.favorites.filter((item) => item.id !== id) };
}

/**
 * 记录最近访问:同 路由+路径 去重并提到最前(更新时间与显示名),按时间倒序保留前 N 条。
 * 同一页面的不同范围各占一条(范围是入口语义的一部分)。
 */
export function recordRecentPage(
  prefs: UserPrefs,
  input: { pageKey: PageKey; path: string; label: string },
  visitedAt: number,
): UserPrefs {
  if (!isPrefsSupportedPage(input.pageKey)) return prefs;
  const label = input.label.trim().slice(0, MAX_LABEL_LENGTH) || '未命名页面';
  const rest = prefs.recents.filter((item) => !(item.pageKey === input.pageKey && item.path === input.path));
  const entry: RecentEntry = { pageKey: input.pageKey, path: input.path, label, visitedAt };
  const recents = [entry, ...rest].slice(0, MAX_RECENTS);
  return { ...prefs, recents };
}
