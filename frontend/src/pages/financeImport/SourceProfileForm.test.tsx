// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { DEFAULT_SOURCE_CONFIG, toConfig, toFormValues, configJson } from './SourceProfileForm';

/**
 * 方案 3.5 的核心约束:**提交载荷必须与改造前完全一致**(同一 JSON schema,
 * 后端接口零改动)。改造前前端直接提交这个字符串化的默认对象:
 *   JSON.stringify({balanceSheetNames:['科目余额表'],profitSheetNames:['利润表'],
 *     journalSheetNames:['凭证序时簿'],balanceLayout:'single_header',
 *     sourceAccountIncludePrefixes:[],ownedOrgCodes:[],ownedAccountCodes:[],
 *     amountUnit:'yuan',maxRows:20000,maxOutputBytes:10485760},null,2)
 * 以下断言把这个契约钉死,结构化表单只许换输入方式,不许换载荷。
 */
const LEGACY_DEFAULT_JSON = JSON.stringify({
  balanceSheetNames: ['科目余额表'],
  profitSheetNames: ['利润表'],
  journalSheetNames: ['凭证序时簿'],
  balanceLayout: 'single_header',
  sourceAccountIncludePrefixes: [],
  ownedOrgCodes: [],
  ownedAccountCodes: [],
  amountUnit: 'yuan',
  maxRows: 20000,
  maxOutputBytes: 10485760,
}, null, 2);

describe('数据源配置表单:载荷契约不变', () => {
  it('默认表单值生成的 config 与改造前的默认 JSON 逐字节一致', () => {
    expect(JSON.stringify(toConfig(toFormValues()), null, 2)).toBe(LEGACY_DEFAULT_JSON);
  });

  it('DEFAULT_SOURCE_CONFIG 本身即旧默认值', () => {
    expect(JSON.stringify(DEFAULT_SOURCE_CONFIG, null, 2)).toBe(LEGACY_DEFAULT_JSON);
  });

  it('键集合与旧载荷完全相同(不多不少)', () => {
    expect(Object.keys(toConfig(toFormValues()))).toEqual(Object.keys(DEFAULT_SOURCE_CONFIG));
  });

  it('configJson 输出与 toConfig 同源,预览即所提交', () => {
    expect(configJson(toFormValues())).toBe(LEGACY_DEFAULT_JSON);
  });
});

describe('数据源配置表单:结构化映射', () => {
  it('用户填写后按原键名落到 config', () => {
    const v = toFormValues();
    const filled = {
      ...v,
      balanceSheetNames: ['余额表', '科目余额表'],
      balanceLayout: 'double_header',
      amountUnit: 'wan',
      maxRows: 5000,
      maxOutputBytes: 2097152,
      sourceAccountIncludePrefixes: ['6001', '6051'],
      ownedOrgCodes: ['A01'],
      ownedAccountCodes: ['6602'],
    };
    const cfg = toConfig(filled);
    expect(cfg).toEqual({
      balanceSheetNames: ['余额表', '科目余额表'],
      profitSheetNames: ['利润表'],
      journalSheetNames: ['凭证序时簿'],
      balanceLayout: 'double_header',
      sourceAccountIncludePrefixes: ['6001', '6051'],
      ownedOrgCodes: ['A01'],
      ownedAccountCodes: ['6602'],
      amountUnit: 'wan',
      maxRows: 5000,
      maxOutputBytes: 2097152,
    });
  });

  it('列表控件留空时仍输出空数组,不变成 null 或 undefined', () => {
    const cfg = toConfig(toFormValues());
    expect(cfg.sourceAccountIncludePrefixes).toEqual([]);
    expect(cfg.ownedOrgCodes).toEqual([]);
    expect(cfg.ownedAccountCodes).toEqual([]);
  });

  it('maxRows/maxOutputBytes 传入字符串(InputNumber 受控场景)时落成数字', () => {
    const cfg = toConfig({ ...toFormValues(), maxRows: '1234' as unknown as number, maxOutputBytes: '2048' as unknown as number });
    expect(cfg.maxRows).toBe(1234);
    expect(cfg.maxOutputBytes).toBe(2048);
  });

  it('从已存在的 config 反填表单时保留原值', () => {
    const v = toFormValues({ ...DEFAULT_SOURCE_CONFIG, balanceLayout: 'double_header', maxRows: 999 });
    expect(v.balanceLayout).toBe('double_header');
    expect(v.maxRows).toBe(999);
    // 未覆盖的键回落到默认值
    expect(v.amountUnit).toBe('yuan');
  });
});
