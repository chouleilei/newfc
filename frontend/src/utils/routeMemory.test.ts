// @vitest-environment jsdom
/**
 * routeMemory(UX-03)单元测试:
 * - 保存/读取往返一致;损坏 JSON、负数、NaN 一律视为无记录
 * - 超出容量时按 savedAt 淘汰最旧条目,不动其他前缀的键
 * - resolveScrollTarget:PUSH 回顶、POP 恢复记录(无记录回顶)、REPLACE 保持原位
 */
import { describe, expect, it } from 'vitest';
import {
  readRoutePosition,
  removeRoutePosition,
  resolveScrollTarget,
  routePositionKey,
  saveRoutePosition,
  type RouteMemoryStorage,
} from './routeMemory';

function memoryStorage(): RouteMemoryStorage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
    key: (index) => [...map.keys()][index] ?? null,
  };
}

describe('routeMemory', () => {
  it('保存后可按条目 key 读回滚动位置', () => {
    const storage = memoryStorage();
    saveRoutePosition(storage, 'k1', 480.6);
    const saved = readRoutePosition(storage, 'k1');
    expect(saved?.scrollTop).toBe(481);
    expect(saved?.savedAt).toBeGreaterThan(0);
    expect(readRoutePosition(storage, 'k2')).toBeNull();
  });

  it('损坏或非法记录一律按无记录处理', () => {
    const storage = memoryStorage();
    storage.setItem(routePositionKey('bad-json'), '{oops');
    storage.setItem(routePositionKey('neg'), JSON.stringify({ scrollTop: -5, savedAt: 1 }));
    storage.setItem(routePositionKey('nan'), JSON.stringify({ scrollTop: 'abc', savedAt: 1 }));
    expect(readRoutePosition(storage, 'bad-json')).toBeNull();
    expect(readRoutePosition(storage, 'neg')).toBeNull();
    expect(readRoutePosition(storage, 'nan')).toBeNull();
  });

  it('非法 scrollTop 不写入;remove 清除记录', () => {
    const storage = memoryStorage();
    saveRoutePosition(storage, 'k1', Number.NaN);
    saveRoutePosition(storage, 'k1', -1);
    expect(readRoutePosition(storage, 'k1')).toBeNull();
    saveRoutePosition(storage, 'k1', 120);
    removeRoutePosition(storage, 'k1');
    expect(readRoutePosition(storage, 'k1')).toBeNull();
  });

  it('超出容量时淘汰最旧条目,不动其他前缀的键', () => {
    const storage = memoryStorage();
    storage.setItem('unrelated', 'keep');
    const now = Date.now();
    const realNow = Date.now;
    try {
      for (let i = 0; i < 61; i += 1) {
        Date.now = () => now + i;
        saveRoutePosition(storage, `k${i}`, i);
      }
    } finally {
      Date.now = realNow;
    }
    expect(readRoutePosition(storage, 'k0')).toBeNull();
    expect(readRoutePosition(storage, 'k60')?.scrollTop).toBe(60);
    expect(storage.getItem('unrelated')).toBe('keep');
  });

  it('resolveScrollTarget:PUSH 回顶,POP 恢复或回顶,REPLACE 不动', () => {
    const saved = { scrollTop: 300, savedAt: 1 };
    expect(resolveScrollTarget('PUSH', saved)).toBe(0);
    expect(resolveScrollTarget('PUSH', null)).toBe(0);
    expect(resolveScrollTarget('POP', saved)).toBe(300);
    expect(resolveScrollTarget('POP', null)).toBe(0);
    expect(resolveScrollTarget('REPLACE', saved)).toBeNull();
    expect(resolveScrollTarget('REPLACE', null)).toBeNull();
  });
});
