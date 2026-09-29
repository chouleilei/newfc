/**
 * 叙述改写公共管道的事实守卫(AI 功能增强计划 §二.1、§三.1–3)。
 *
 * 复核发现的两个绕过口:
 * 1. factTokens 只识别数字与「含数字的字母编码」,纯字母编码(REQUIRED_VALUE_MISSING、
 *    SH/HZ)与中文专名(上海公司/杭州公司)都不在 multiset 里,模型可以偷换而守卫仍通过;
 * 2. 守卫先执行、截断后执行,截断掉的事实不会被守卫发现。
 * 本文件把这两条钉住,并覆盖 factTerms 的重叠词条与缓存键口径。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  factTokens, narrativeNumbersIntact, narrativeCacheKey, resetNarrativeCache, rewriteTemplateNarrative,
} from '../src/assistant/narrative';

function stubModel(content: string): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('事实 token 守卫:编码识别', () => {
  it('纯字母编码进入 multiset:问题编码与组织编码都不能被偷换', () => {
    expect(factTokens('REQUIRED_VALUE_MISSING')).toEqual(['code:REQUIRED_VALUE_MISSING']);
    expect(factTokens('SH 与 HZ')).toEqual(['code:SH', 'code:HZ']);
    // 编码被替换 -> 守卫失败
    const swapped = narrativeNumbersIntact('阻断项 REQUIRED_VALUE_MISSING 共 3 条', '阻断项 BASIS_MISSING 共 3 条');
    expect(swapped.ok).toBe(false);
    // 编码被删除 -> 守卫失败
    expect(narrativeNumbersIntact('STRUCTURE_INVALID 共 1 条', '结构问题共 1 条').ok).toBe(false);
    // 编码原样保留、只改行文 -> 通过
    expect(narrativeNumbersIntact('STRUCTURE_INVALID 共 1 条', '共 1 条 STRUCTURE_INVALID 待处理').ok).toBe(true);
  });

  it('含数字编码与数字口径保持原有语义', () => {
    expect(factTokens('I1103 与 P02 共 1,234.50 元,同比 3%')).toEqual([
      'code:I1103', 'code:P02', 'number:1234.50', 'number:3%',
    ]);
    // ASCII 千分位与显式正号仍被归一
    expect(narrativeNumbersIntact('合计 1,234 元', '合计 1234 元').ok).toBe(true);
    expect(narrativeNumbersIntact('增加 +5 元', '增加 5 元').ok).toBe(true);
  });
});

describe('事实 token 守卫:中文专名词条', () => {
  const terms = ['上海公司', '杭州公司', '主营业务收入'];

  it('声明词条后专名被偷换即回退', () => {
    // 未声明词条时(旧行为)偷换不会被发现
    expect(narrativeNumbersIntact('SH 上海公司 3 处', 'SH 上海公司 3 处').ok).toBe(true);
    // 声明词条后:名称被替换 -> 失败
    const swapped = narrativeNumbersIntact('组织 上海公司 共 3 处', '组织 杭州公司 共 3 处', terms);
    expect(swapped.ok).toBe(false);
    expect(swapped.ok === false && swapped.missing.join()).toContain('上海公司');
    expect(swapped.ok === false && swapped.extra.join()).toContain('杭州公司');
    // 名称被删除 -> 失败
    expect(narrativeNumbersIntact('组织 上海公司 共 3 处', '该组织共 3 处', terms).ok).toBe(false);
    // 出现次数变化 -> 失败
    expect(narrativeNumbersIntact('上海公司 1 处', '上海公司与上海公司 1 处', terms).ok).toBe(false);
    // 只改行文、专名与次数不变 -> 通过
    expect(narrativeNumbersIntact('组织 上海公司 共 3 处', '共 3 处变化集中在组织 上海公司', terms).ok).toBe(true);
  });

  it('重叠词条两侧口径一致,单字词条被忽略', () => {
    const overlapping = ['上海', '上海公司'];
    expect(narrativeNumbersIntact('上海公司 1 处', '上海公司 1 处', overlapping).ok).toBe(true);
    expect(narrativeNumbersIntact('上海公司 1 处', '上海 1 处', overlapping).ok).toBe(false);
    // 单字词条在中文散文里必然误命中,不纳入守卫
    expect(narrativeNumbersIntact('海 1 处', '湖 1 处', ['海']).ok).toBe(true);
  });
});

describe('叙述改写:截断与守卫顺序', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.AI_BASE_URL = '';
    process.env.AI_API_KEY = '';
    resetNarrativeCache();
  });

  it('截断发生在守卫之前:被截掉的事实会让整篇退回模板', async () => {
    process.env.AI_BASE_URL = 'http://model.test/v1';
    process.env.AI_API_KEY = 'test';
    const template = '合计 100 万元,组织 上海公司';
    // 模型返回的文本事实齐全,但超出 maxChars;截断后会丢掉尾部事实
    stubModel('合计 100 万元,组织 上海公司');
    const result = await rewriteTemplateNarrative({
      enabled: true,
      promptVersion: 'test.v1',
      task: 't',
      template,
      factTerms: ['上海公司'],
      maxChars: 12,
    });
    expect(result.source).toBe('template');
    expect(result.text).toBe(template);
    expect(result.guardFailure).toBeDefined();
  });

  it('不截断且事实齐全时返回模型稿;缓存键含事实词条', async () => {
    process.env.AI_BASE_URL = 'http://model.test/v1';
    process.env.AI_API_KEY = 'test';
    const template = '合计 100 万元,组织 上海公司';
    const spy = stubModel('组织 上海公司 合计 100 万元');
    const first = await rewriteTemplateNarrative({
      enabled: true, promptVersion: 'test.v1', task: 't', template, factTerms: ['上海公司'],
    });
    expect(first.source).toBe('model');
    expect(first.cached).toBe(false);
    // 同 prompt 版本 + 同模板 + 同词条 -> 命中缓存,不再调用模型
    const second = await rewriteTemplateNarrative({
      enabled: true, promptVersion: 'test.v1', task: 't', template, factTerms: ['上海公司'],
    });
    expect(second.cached).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    // 词条变化 -> 缓存键变化 -> 重新调用模型
    const third = await rewriteTemplateNarrative({
      enabled: true, promptVersion: 'test.v1', task: 't', template, factTerms: ['上海公司', '主营业务收入'],
    });
    expect(third.cached).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(narrativeCacheKey('test.v1', template, ['a'])).not.toBe(narrativeCacheKey('test.v1', template, ['b']));
    expect(narrativeCacheKey('test.v1', template, ['a', 'b'])).toBe(narrativeCacheKey('test.v1', template, ['b', 'a']));
  });

  it('开关关闭或模型未配置时不发生任何网络调用', async () => {
    const spy = stubModel('任意');
    const disabled = await rewriteTemplateNarrative({ enabled: false, promptVersion: 'v', task: 't', template: 'x' });
    expect(disabled.source).toBe('template');
    // 未配置模型
    const unconfigured = await rewriteTemplateNarrative({ enabled: true, promptVersion: 'v', task: 't', template: 'x' });
    expect(unconfigured.source).toBe('template');
    expect(spy).not.toHaveBeenCalled();
  });
});
