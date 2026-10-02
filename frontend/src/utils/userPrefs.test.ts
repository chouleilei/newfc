// @vitest-environment jsdom
/**
 * userPrefs(UX-25)单元测试:
 * - 命名空间/键名、保存读取往返、schemaVersion 不符或 JSON 损坏时降级为空并自愈(不抛出);
 * - 视图/收藏/最近使用只保留白名单路由与白名单参数,注入的越界参数与非法条目被剔除;
 * - 视图增删改、收藏切换、最近记录去重排序与容量上限;
 * - 重置只清 `newfc:prefs:` 键,不动其他存储内容。
 */
import { describe, expect, it } from 'vitest';
import {
  addSavedView,
  deleteSavedView,
  emptyUserPrefs,
  entryPathFor,
  findFavorite,
  loadUserPrefs,
  MAX_FAVORITES,
  MAX_RECENTS,
  MAX_SAVED_VIEWS,
  prefsNamespaceFor,
  prefsStorageKey,
  recordRecentPage,
  removeFavorite,
  renameSavedView,
  resetUserPrefs,
  saveUserPrefs,
  toggleFavorite,
  PREFS_SCHEMA_VERSION,
  type PrefsStorage,
  type UserPrefs,
} from './userPrefs';

function memoryStorage(): PrefsStorage & { dump: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    dump: map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
  };
}

const NS = 'user-admin';
let idSeq = 0;
const idGen = () => `id-${(idSeq += 1)}`;

describe('命名空间与键名', () => {
  it('登录用户按 ID 隔离,同名或中文显示名不共用收藏与最近访问', () => {
    const first = prefsNamespaceFor('财务人员', 11);
    const second = prefsNamespaceFor('财务人员', 12);
    expect(first).not.toBe(second);
    expect(prefsNamespaceFor('改名后的财务人员', 11)).toBe(first);
    expect(prefsNamespaceFor('id-11')).not.toBe(first);
    const storage = memoryStorage();
    const prefs = toggleFavorite(emptyUserPrefs(), { pageKey: 'analysis', path: '/analysis', label: '年度执行分析' }, 1000, idGen).prefs;
    saveUserPrefs(storage, first, prefs);
    expect(loadUserPrefs(storage, first).favorites).toHaveLength(1);
    expect(loadUserPrefs(storage, second).favorites).toHaveLength(0);
  });
  it('按用户名派生命名空间,特殊字符收敛,空值落 default', () => {
    expect(prefsNamespaceFor('Admin')).toBe('user-admin');
    expect(prefsNamespaceFor('Zhang.San')).toBe('user-zhang-san');
    expect(prefsNamespaceFor('本机模式')).toBe('default');
    expect(prefsNamespaceFor(null)).toBe('default');
    expect(prefsStorageKey('user-admin')).toBe('newfc:prefs:user-admin');
  });
});

describe('读取与自愈', () => {
  it('空存储返回空偏好;保存后可完整读回(重进应用可恢复)', () => {
    const storage = memoryStorage();
    expect(loadUserPrefs(storage, NS)).toEqual(emptyUserPrefs());
    let prefs = emptyUserPrefs();
    const saved = addSavedView(prefs, { name: 'A 电站年度执行', pageKey: 'analysis', search: 'year=2026&version=3' }, 1000, idGen);
    expect(saved).not.toBeNull();
    prefs = saved!.prefs;
    prefs = toggleFavorite(prefs, { pageKey: 'analysis', path: '/analysis?year=2026&version=3', label: '年度执行分析' }, 1001, idGen).prefs;
    prefs = recordRecentPage(prefs, { pageKey: 'analysis', path: '/analysis?year=2026', label: '年度执行分析' }, 1002);
    saveUserPrefs(storage, NS, prefs);
    const loaded = loadUserPrefs(storage, NS);
    expect(loaded.savedViews).toHaveLength(1);
    expect(loaded.savedViews[0].name).toBe('A 电站年度执行');
    expect(loaded.savedViews[0].search).toBe('year=2026&version=3');
    expect(loaded.favorites).toHaveLength(1);
    expect(loaded.recents).toHaveLength(1);
  });

  it('损坏 JSON:返回空偏好并清除坏键(自愈),不抛出', () => {
    const storage = memoryStorage();
    storage.setItem(prefsStorageKey(NS), '{oops');
    expect(loadUserPrefs(storage, NS)).toEqual(emptyUserPrefs());
    expect(storage.getItem(prefsStorageKey(NS))).toBeNull();
  });

  it('schemaVersion 不符:视为过期数据,清空后返回空偏好', () => {
    const storage = memoryStorage();
    storage.setItem(prefsStorageKey(NS), JSON.stringify({ schemaVersion: 999, savedViews: [{ id: 'x' }] }));
    expect(loadUserPrefs(storage, NS)).toEqual(emptyUserPrefs());
    expect(storage.getItem(prefsStorageKey(NS))).toBeNull();
  });

  it('部分条目非法:剔除后写回干净副本,合法条目保留', () => {
    const storage = memoryStorage();
    const good = { id: 'v1', name: '好视图', pageKey: 'analysis', search: 'year=2026', createdAt: 1, updatedAt: 1 };
    storage.setItem(prefsStorageKey(NS), JSON.stringify({
      schemaVersion: PREFS_SCHEMA_VERSION,
      savedViews: [good, { id: 'bad' }, { id: 'v2', name: '越权路由', pageKey: 'not_a_page', search: '' }],
      favorites: 'oops',
    }));
    const loaded = loadUserPrefs(storage, NS);
    expect(loaded.savedViews).toHaveLength(1);
    expect(loaded.savedViews[0].id).toBe('v1');
    expect(loaded.favorites).toEqual([]);
    // 自愈写回:再读一次不应再触发剔除
    expect(JSON.parse(storage.getItem(prefsStorageKey(NS))!).savedViews).toHaveLength(1);
  });

  it('存储抛错(隐私模式)时读取降级为空偏好,不阻塞页面', () => {
    const broken: PrefsStorage = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    };
    expect(loadUserPrefs(broken, NS)).toEqual(emptyUserPrefs());
    expect(() => saveUserPrefs(broken, NS, emptyUserPrefs())).not.toThrow();
    expect(() => resetUserPrefs(broken, NS)).not.toThrow();
  });
});

describe('白名单约束', () => {
  it('保存视图只保留白名单参数:外来参数(凭证样/一次性定位)被丢弃', () => {
    const saved = addSavedView(emptyUserPrefs(), {
      name: 'v', pageKey: 'analysis',
      search: 'year=2026&version=3&token=secret&confirm=abc&foo=bar',
    }, 1000, idGen);
    expect(saved!.entry.search).toBe('year=2026&version=3');
  });

  it('视图只接受支持范围的路由;非法参数值在保存时被规范化丢弃', () => {
    expect(addSavedView(emptyUserPrefs(), { name: 'v', pageKey: 'dashboard', search: 'year=2026' }, 1, idGen)).not.toBeNull();
    expect(addSavedView(emptyUserPrefs(), { name: 'v', pageKey: 'org', search: '' }, 1, idGen)).toBeNull();
    const saved = addSavedView(emptyUserPrefs(), { name: 'v', pageKey: 'analysis', search: 'year=abc&version=3' }, 1, idGen);
    expect(saved!.entry.search).toBe('version=3');
  });

  it('entryPathFor:/data 保留合法 tab,范围参数按白名单重建', () => {
    expect(entryPathFor('imports', '/data', 'tab=imports&year=2026')).toBe('/data?tab=imports');
    expect(entryPathFor('data_check', '/data', 'tab=check')).toBe('/data?tab=check');
    expect(entryPathFor('backup', '/data', 'tab=evil"><script>')).toBe('/data');
    expect(entryPathFor('analysis', '/analysis', 'year=2026&hack=1')).toBe('/analysis?year=2026');
    expect(entryPathFor('org', '/org', '')).toBe('/org');
  });

  it('读取时对收藏的 path 再规范化:手改存储注入的越界参数不会进入页面', () => {
    const storage = memoryStorage();
    storage.setItem(prefsStorageKey(NS), JSON.stringify({
      schemaVersion: PREFS_SCHEMA_VERSION,
      favorites: [{ id: 'f1', pageKey: 'analysis', path: '/analysis?year=2026&token=x', label: '分析', createdAt: 1 }],
      recents: [{ pageKey: 'analysis', path: 'https://evil.example/?year=2026', label: '坏', visitedAt: 1 }],
    }));
    const loaded = loadUserPrefs(storage, NS);
    expect(loaded.favorites[0].path).toBe('/analysis?year=2026');
    expect(loaded.recents).toEqual([]);
  });
});

describe('命名视图', () => {
  it('改名与删除;空名/未知 id 不改动', () => {
    let prefs = addSavedView(emptyUserPrefs(), { name: '原始', pageKey: 'analysis', search: 'year=2026' }, 100, idGen)!.prefs;
    const id = prefs.savedViews[0].id;
    prefs = renameSavedView(prefs, id, '  A 电站年度执行  ', 200);
    expect(prefs.savedViews[0].name).toBe('A 电站年度执行');
    expect(prefs.savedViews[0].updatedAt).toBe(200);
    expect(renameSavedView(prefs, id, '   ', 300)).toBe(prefs);
    expect(renameSavedView(prefs, 'missing', 'x', 300)).toBe(prefs);
    prefs = deleteSavedView(prefs, id);
    expect(prefs.savedViews).toEqual([]);
    expect(deleteSavedView(prefs, id)).toBe(prefs);
  });

  it('达到上限后拒绝新增并返回 null', () => {
    let prefs = emptyUserPrefs();
    for (let i = 0; i < MAX_SAVED_VIEWS; i += 1) {
      prefs = addSavedView(prefs, { name: `v${i}`, pageKey: 'analysis', search: `year=${2000 + i}` }, i, idGen)!.prefs;
    }
    expect(addSavedView(prefs, { name: 'overflow', pageKey: 'analysis', search: '' }, 9999, idGen)).toBeNull();
  });
});

describe('页面收藏', () => {
  it('同 路由+路径 切换收藏;不同范围是不同收藏', () => {
    let prefs = emptyUserPrefs();
    const a = toggleFavorite(prefs, { pageKey: 'analysis', path: '/analysis?year=2026', label: '年度执行分析' }, 1, idGen);
    expect(a.favorited).toBe(true);
    prefs = a.prefs;
    const b = toggleFavorite(prefs, { pageKey: 'analysis', path: '/analysis?year=2025', label: '年度执行分析' }, 2, idGen);
    expect(b.prefs.favorites).toHaveLength(2);
    prefs = b.prefs;
    expect(findFavorite(prefs, 'analysis', '/analysis?year=2026')).toBeDefined();
    const off = toggleFavorite(prefs, { pageKey: 'analysis', path: '/analysis?year=2026', label: '年度执行分析' }, 3, idGen);
    expect(off.favorited).toBe(false);
    expect(off.prefs.favorites).toHaveLength(1);
  });

  it('达到上限后新增返回 favorited=false 且不改动;removeFavorite 按 id 删除', () => {
    let prefs = emptyUserPrefs();
    for (let i = 0; i < MAX_FAVORITES; i += 1) {
      prefs = toggleFavorite(prefs, { pageKey: 'analysis', path: `/analysis?year=${2000 + i}`, label: 'l' }, i, idGen).prefs;
    }
    const result = toggleFavorite(prefs, { pageKey: 'analysis', path: '/analysis?year=2099', label: 'l' }, 9999, idGen);
    expect(result.favorited).toBe(false);
    expect(result.prefs.favorites).toHaveLength(MAX_FAVORITES);
    const id = prefs.favorites[0].id;
    prefs = removeFavorite(prefs, id);
    expect(prefs.favorites).toHaveLength(MAX_FAVORITES - 1);
    expect(removeFavorite(prefs, id)).toBe(prefs);
  });
});

describe('最近使用', () => {
  it('去重提到最前并更新时间;按容量截断', () => {
    let prefs = emptyUserPrefs();
    prefs = recordRecentPage(prefs, { pageKey: 'analysis', path: '/analysis?year=2025', label: '年度执行分析' }, 1);
    prefs = recordRecentPage(prefs, { pageKey: 'structure', path: '/structure', label: '结构占比' }, 2);
    prefs = recordRecentPage(prefs, { pageKey: 'analysis', path: '/analysis?year=2026', label: '年度执行分析' }, 3);
    expect(prefs.recents.map((r) => r.path)).toEqual(['/analysis?year=2026', '/structure', '/analysis?year=2025']);
    // 重复访问旧路径:提到最前、时间更新,不产生重复条目
    prefs = recordRecentPage(prefs, { pageKey: 'analysis', path: '/analysis?year=2025', label: '年度执行分析' }, 4);
    expect(prefs.recents.map((r) => r.path)).toEqual(['/analysis?year=2025', '/analysis?year=2026', '/structure']);
    expect(prefs.recents[0].visitedAt).toBe(4);
    for (let i = 0; i < MAX_RECENTS + 3; i += 1) {
      prefs = recordRecentPage(prefs, { pageKey: 'analysis', path: `/analysis?year=${1900 + i}`, label: 'l' }, 10 + i);
    }
    expect(prefs.recents).toHaveLength(MAX_RECENTS);
  });

  it('不支持的路由不记录', () => {
    const prefs = recordRecentPage(emptyUserPrefs(), { pageKey: 'not_a_page' as never, path: '/x', label: 'l' }, 1);
    expect(prefs.recents).toEqual([]);
  });
});

describe('重置', () => {
  it('只删除本命名空间的偏好键,其他键与业务数据不受影响', () => {
    const storage = memoryStorage();
    storage.setItem('budget-access-token', 'keep');
    storage.setItem(prefsStorageKey('user-other'), 'keep-other');
    saveUserPrefs(storage, NS, recordRecentPage(emptyUserPrefs(), { pageKey: 'org', path: '/org', label: '组织' }, 1));
    expect(loadUserPrefs(storage, NS).recents).toHaveLength(1);
    resetUserPrefs(storage, NS);
    expect(loadUserPrefs(storage, NS)).toEqual(emptyUserPrefs());
    expect(storage.getItem('budget-access-token')).toBe('keep');
    expect(storage.getItem(prefsStorageKey('user-other'))).toBe('keep-other');
  });
});
