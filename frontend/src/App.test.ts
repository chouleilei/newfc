/**
 * 侧栏导航扩展计划 阶段一验收:5 个新叶子项的 selectedKey 白名单、
 * dataMenuKey 归并(导入批次/一致性检查恢复为独立入口)与 pageTitle 特判。
 */
import { describe, expect, it } from 'vitest';
import { dataMenuKey, pageTitle, selectedKey } from './App';

describe('侧栏高亮与归并(阶段一)', () => {
  it('新增叶子项均在 selectedKey 白名单内', () => {
    expect(selectedKey('/insights', '')).toBe('/insights');
    expect(selectedKey('/master-health', '')).toBe('/master-health');
    expect(selectedKey('/cleaning-config', '')).toBe('/cleaning-config');
    expect(selectedKey('/progress', '')).toBe('/progress');
    expect(selectedKey('/alerts', '')).toBe('/alerts');
    expect(selectedKey('/metric-trend', '')).toBe('/metric-trend');
    expect(selectedKey('/settings/ai', '')).toBe('/settings/ai');
    // 既有行为不变
    expect(selectedKey('/assistant', '')).toBe('/assistant');
    expect(selectedKey('/budget', '')).toBe('/budget');
    expect(selectedKey('/nope', '')).toBe('/');
  });

  it('dataMenuKey:导入批次/一致性检查映射到自身,测算模板仍归并到宿主页', () => {
    expect(dataMenuKey('imports')).toBe('/data?tab=imports');
    expect(dataMenuKey('check')).toBe('/data?tab=check');
    expect(dataMenuKey('calculations')).toBe('/budget');
    expect(dataMenuKey('yearclose')).toBe('/data?tab=yearclose');
    expect(dataMenuKey('logs')).toBe('/data?tab=logs');
    expect(dataMenuKey(null)).toBe('/data?tab=backup');
    expect(selectedKey('/data', '?tab=imports')).toBe('/data?tab=imports');
    expect(selectedKey('/data', '?tab=check')).toBe('/data?tab=check');
    expect(selectedKey('/data', '?tab=backup')).toBe('/data?tab=backup');
  });

  it('pageTitle:/data?tab= 特判与既有页签', () => {
    expect(pageTitle('/data', '?tab=check', '/data?tab=check')).toBe('一致性检查');
    expect(pageTitle('/data', '?tab=imports', '/data?tab=imports')).toBe('导入批次');
    expect(pageTitle('/data', '?tab=calculations', '/budget')).toBe('测算模板');
    expect(pageTitle('/progress', '', '/progress')).toBe('进度总览');
    expect(pageTitle('/alerts', '', '/alerts')).toBe('预警中心');
    expect(pageTitle('/metric-trend', '', '/metric-trend')).toBe('指标趋势');
    expect(pageTitle('/insights', '', '/insights')).toBe('洞察报告');
    expect(pageTitle('/master-health', '', '/master-health')).toBe('健康体检');
    expect(pageTitle('/cleaning-config', '', '/cleaning-config')).toBe('清洗模板与别名');
    expect(pageTitle('/settings/ai', '', '/settings/ai')).toBe('AI 渠道设置');
  });
});
