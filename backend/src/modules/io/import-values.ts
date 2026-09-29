import { wanStringToYuanString } from '../../core/money';

export type ImportAmountUnit = 'yuan' | 'wan';

/** Excel 数值文本的共享、确定性清洗；不做任何单位或利润方向猜测。 */
export function normalizeImportedNumber(raw: string): string {
  let value = raw.replace(/[\u00a0\u3000]/g, ' ').trim();
  value = value.replace(/^"(.*)"$/, '$1').replace(/[¥￥]/g, '').trim();
  value = value.replace(/[,，\s]/g, '').replace(/[．]/g, '.').replace(/[＋]/g, '+').replace(/[－]/g, '-');
  value = value.replace(/^[（(](.*)[）)]$/, '-$1');
  return value === '-' ? '' : value;
}

/** 源金额按用户明确选择的单位转换成标准元字符串。 */
export function importedAmountToYuan(raw: string, unit: ImportAmountUnit): string {
  const normalized = normalizeImportedNumber(raw);
  if (!normalized) return '';
  return unit === 'wan' ? wanStringToYuanString(normalized) : normalized;
}
