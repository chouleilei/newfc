/** 同源浏览器偏好兼容：只迁移已知旧键；账号偏好只接受服务端 ID 命名空间。 */
interface BrowserStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function legacyKey(key: string): string | null {
  if (key === 'newfc-theme-mode') return 'budget-theme-mode';
  if (/^newfc:prefs:account:[1-9]\d*$/.test(key)) return key.replace(/^newfc:/, 'bd:');
  if (key.startsWith('newfc:route-pos:')) return key.replace(/^newfc:/, 'bd:');
  if (key.startsWith('newfc-')) return key.replace(/^newfc-/, 'bd-');
  return null;
}

function migratePreferenceLabels(raw: string): string {
  try {
    const prefs = JSON.parse(raw);
    for (const field of ['favorites', 'recents']) {
      if (!Array.isArray(prefs?.[field])) continue;
      for (const item of prefs[field]) {
        if (item?.label === '小澧助手') item.label = '财务助手';
      }
    }
    return JSON.stringify(prefs);
  } catch {
    return raw; // 结构校验仍由偏好读取模块完成。
  }
}

export function readBrowserStorage(storage: BrowserStorage, key: string): string | null {
  try {
    const current = storage.getItem(key);
    if (current !== null) return current;
    const previous = legacyKey(key);
    if (!previous) return null;
    const oldRaw = storage.getItem(previous);
    if (oldRaw === null) return null;
    const raw = key.startsWith('newfc:prefs:') ? migratePreferenceLabels(oldRaw) : oldRaw;
    // 先写成功再删旧键；配额不足时继续使用旧值，避免丢失偏好。
    try {
      storage.setItem(key, raw);
      storage.removeItem(previous);
    } catch { /* 下次读取仍可重试迁移 */ }
    return raw;
  } catch {
    return null;
  }
}

export function removeBrowserStorage(storage: BrowserStorage, key: string): void {
  try {
    storage.removeItem(key);
    const previous = legacyKey(key);
    if (previous) storage.removeItem(previous);
  } catch { /* 隐私模式不阻塞页面 */ }
}
