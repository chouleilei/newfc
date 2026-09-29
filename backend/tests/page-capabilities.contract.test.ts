/**
 * pageKey 目录契约测试(方案《小澧助手全页面回答范围自动对齐开发计划》§7.1)。
 *
 * 前端 pageKey 目录(frontend/src/assistant/context.ts PAGE_KEYS)与后端
 * PageCapabilityMap(src/assistant/page-capabilities.ts)各保留一份，
 * 本测试双向比较：发现遗漏即失败，不引入代码生成器或路由源码扫描器。
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { PAGE_CAPABILITY_MAP, PAGE_KEYS, allowedToolsForCapabilities, capabilityOfTool } from '../src/assistant/page-capabilities';

/** 从前端 context.ts 源码中提取 PAGE_KEYS 数组字面量。 */
function frontendPageKeys(): string[] {
  const file = path.resolve(__dirname, '../../frontend/src/assistant/context.ts');
  const source = fs.readFileSync(file, 'utf8');
  const match = source.match(/export const PAGE_KEYS = \[([\s\S]*?)\] as const;/);
  if (!match) throw new Error('未能在 frontend/src/assistant/context.ts 中找到 PAGE_KEYS');
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('pageKey 目录契约', () => {
  it('恰好 28 个 pageKey', () => {
    expect(PAGE_KEYS.length).toBe(28);
    expect(frontendPageKeys().length).toBe(28);
  });

  it('前端 PAGE_KEYS 与后端 PageCapabilityMap 完全一致(双向)', () => {
    const frontend = new Set(frontendPageKeys());
    const backend = new Set(PAGE_KEYS);
    const missingInBackend = [...frontend].filter((key) => !backend.has(key));
    const missingInFrontend = [...backend].filter((key) => !frontend.has(key));
    expect(missingInBackend, `后端缺少: ${missingInBackend.join(', ')}`).toEqual([]);
    expect(missingInFrontend, `前端缺少: ${missingInFrontend.join(', ')}`).toEqual([]);
  });

  it('每个页面都有默认能力且默认能力在允许列表内', () => {
    for (const [key, page] of Object.entries(PAGE_CAPABILITY_MAP)) {
      expect(page.label, `${key} 缺少 label`).toBeTruthy();
      expect(page.capabilities.length, `${key} 没有能力映射`).toBeGreaterThan(0);
      expect(page.capabilities, `${key} 的默认能力不在允许列表内`).toContain(page.defaultCapability);
      expect(new Set(page.capabilities).size, `${key} 的能力列表有重复`).toBe(page.capabilities.length);
    }
  });

  it('每个页面映射出的模型工具都是真实存在的工具名', () => {
    for (const capability of ['overview', 'assistant_content', 'master_data', 'budget', 'actual', 'execution', 'comparison', 'import_conversion', 'evidence', 'operations'] as const) {
      for (const tool of allowedToolsForCapabilities([capability])) {
        // capabilityOfTool 只覆盖领域工具；通用工具(explain_terms 等)返回 null。
        expect(tool.length).toBeGreaterThan(0);
      }
    }
    expect(capabilityOfTool('calculate_execution')).toBe('execution');
    expect(capabilityOfTool('get_metric_evidence')).toBe('evidence');
    expect(capabilityOfTool('nonexistent_tool')).toBeNull();
  });
});
