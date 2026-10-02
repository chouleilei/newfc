/**
 * 路由返回位置记忆(方案《易用性与直觉化交互实施方案》§5.1,任务 UX-03)。
 *
 * 以 history 条目 key 为标识,在 sessionStorage 记录每个条目离开时的滚动位置:
 * - 跨页下钻是 push:新条目没有记录 → 回到顶部;
 * - 范围切换是 replace:同一条目 → 不打扰当前位置;
 * - 浏览器返回是 pop:条目已有记录 → 恢复离开时的位置。
 * 筛选条件本身由 UX-02 进入 URL 并随条目恢复,这里不重复保存。
 */
import { readBrowserStorage, removeBrowserStorage } from './browserStorage';

export interface RoutePosition {
  scrollTop: number;
  savedAt: number;
}

/** 导航类型 → 目标滚动位置;null 表示保持当前位置不动。 */
export type RouteNavAction = 'PUSH' | 'POP' | 'REPLACE';

const PREFIX = 'newfc:route-pos:';
/** 上限防止长期使用塞满 sessionStorage;超出时按 savedAt 淘汰最旧条目。 */
const MAX_ENTRIES = 60;

/** 兼容 sessionStorage 的最小接口,便于测试注入内存实现。 */
export interface RouteMemoryStorage {
  readonly length: number;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
}

export function routePositionKey(locationKey: string): string {
  return `${PREFIX}${locationKey}`;
}

/** 读取某条目的位置记录;损坏/越界数据一律视为无记录,绝不抛错阻塞页面。 */
export function readRoutePosition(storage: RouteMemoryStorage, locationKey: string): RoutePosition | null {
  try {
    const raw = readBrowserStorage(storage, routePositionKey(locationKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { scrollTop?: unknown; savedAt?: unknown } | null;
    if (!parsed || typeof parsed.scrollTop !== 'number' || !Number.isFinite(parsed.scrollTop) || parsed.scrollTop < 0) return null;
    return {
      scrollTop: parsed.scrollTop,
      savedAt: typeof parsed.savedAt === 'number' && Number.isFinite(parsed.savedAt) ? parsed.savedAt : 0,
    };
  } catch {
    return null;
  }
}

function pruneRoutePositions(storage: RouteMemoryStorage): void {
  try {
    const entries: { key: string; savedAt: number }[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (!key || !key.startsWith(PREFIX)) continue;
      const raw = storage.getItem(key);
      let savedAt = 0;
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as { savedAt?: unknown };
          if (typeof parsed?.savedAt === 'number' && Number.isFinite(parsed.savedAt)) savedAt = parsed.savedAt;
        } catch { /* 损坏记录 savedAt 记 0,优先淘汰 */ }
      }
      entries.push({ key, savedAt });
    }
    const overflow = entries.length - MAX_ENTRIES + 1;
    if (overflow <= 0) return;
    entries.sort((a, b) => a.savedAt - b.savedAt);
    for (const entry of entries.slice(0, overflow)) storage.removeItem(entry.key);
  } catch { /* 淘汰失败不阻塞保存 */ }
}

/** 保存某条目的滚动位置;隐私模式/配额满时静默降级(位置恢复是增强而非业务正确性)。 */
export function saveRoutePosition(storage: RouteMemoryStorage, locationKey: string, scrollTop: number): void {
  if (!Number.isFinite(scrollTop) || scrollTop < 0) return;
  try {
    pruneRoutePositions(storage);
    storage.setItem(routePositionKey(locationKey), JSON.stringify({ scrollTop: Math.round(scrollTop), savedAt: Date.now() }));
  } catch { /* 见函数注释 */ }
}

export function removeRoutePosition(storage: RouteMemoryStorage, locationKey: string): void {
  try {
    removeBrowserStorage(storage, routePositionKey(locationKey));
  } catch { /* 同上 */ }
}

/**
 * 决定条目切换后的目标滚动位置:
 * - PUSH(跨页下钻/新入口):回顶;
 * - POP(浏览器返回):有记录恢复记录,无记录回顶;
 * - REPLACE(范围切换/URL 自愈):返回 null,保持当前位置。
 */
export function resolveScrollTarget(action: RouteNavAction, saved: RoutePosition | null): number | null {
  if (action === 'REPLACE') return null;
  if (action === 'POP') return saved ? saved.scrollTop : 0;
  return 0;
}
