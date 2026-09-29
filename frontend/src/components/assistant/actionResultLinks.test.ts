/**
 * actionResultLinks / summarizeActionResult(UX-26)测试：
 * 确认成功后的业务化结果摘要与「查看结果」跳转。
 */
import { describe, expect, it } from 'vitest';
import { actionResultLinks, summarizeActionResult } from './actionResultLinks';

describe('summarizeActionResult', () => {
  it('未确认或无结果时不给摘要', () => {
    expect(summarizeActionResult({ type: 'copy_budget', status: 'pending', preview: {}, result: null })).toBeNull();
    expect(summarizeActionResult({ type: 'copy_budget', status: 'confirmed', preview: {}, result: null })).toBeNull();
  });

  it('复制/草案版本说明新版本与当前采用未变化', () => {
    const text = summarizeActionResult({ type: 'copy_budget', status: 'confirmed', preview: {}, result: { id: 8, name: '2026 修订', year: 2026 } });
    expect(text).toContain('「2026 修订」');
    expect(text).toContain('2026 年');
    expect(text).toContain('#8');
    expect(text).toContain('当前采用版本未变化');
  });

  it('批量调整给出写入/清除数量', () => {
    const text = summarizeActionResult({ type: 'bulk_adjustment', status: 'confirmed', preview: { versionId: 3 }, result: { saved: 12, deleted: 2, cellNotesSaved: 0, revision: 5 } });
    expect(text).toBe('已按确认内容更新草稿明细：写入 12 条，清除 2 条');
  });

  it('情景测算明确未写入数据', () => {
    expect(summarizeActionResult({ type: 'scenario', status: 'confirmed', preview: {}, result: { accepted: true } })).toContain('未写入');
  });
});

describe('actionResultLinks', () => {
  it('只有 confirmed 状态才给跳转', () => {
    expect(actionResultLinks({ type: 'budget_draft', status: 'pending', preview: {}, result: { id: 5 } })).toEqual([]);
  });

  it('新版本跳到预算编辑页对应版本', () => {
    expect(actionResultLinks({ type: 'budget_draft', status: 'confirmed', preview: {}, result: { id: 5, name: 'x', year: 2026 } }))
      .toEqual([{ path: '/budget/5', label: '查看结果（打开新版本）' }]);
    expect(actionResultLinks({ type: 'copy_budget', status: 'confirmed', preview: {}, result: { id: 6 } })[0].path).toBe('/budget/6');
  });

  it('批量调整跳到预览目标版本', () => {
    expect(actionResultLinks({ type: 'bulk_adjustment', status: 'confirmed', preview: { versionId: 3 }, result: { saved: 1, deleted: 0, revision: 2 } }))
      .toEqual([{ path: '/budget/3', label: '查看结果（打开目标版本明细）' }]);
  });

  it('测算依据草稿跳到助手页洞察', () => {
    expect(actionResultLinks({ type: 'basis_text', status: 'confirmed', preview: {}, result: { insightId: 4 } })[0].path).toBe('/assistant');
  });

  it('情景测算与导出不提供页面跳转', () => {
    expect(actionResultLinks({ type: 'scenario', status: 'confirmed', preview: {}, result: { accepted: true } })).toEqual([]);
    expect(actionResultLinks({ type: 'export', status: 'confirmed', preview: {}, result: { downloadUrl: '/x' } })).toEqual([]);
  });
});
