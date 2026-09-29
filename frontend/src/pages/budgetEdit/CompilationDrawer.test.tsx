import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { checkpointChangeFlags, filterCheckpointChanges, FormulaDiff, NoteDiff, noteChangeKind, quantityText } from './CompilationDrawer';

const value = (amountCents = 0, quantity: number | null = null, formula = '', note = '') => ({ amountCents, quantity, formula, note });

describe('noteChangeKind', () => {
  it('识别新增、修改、清空及无变化', () => {
    expect(noteChangeKind('', '')).toBe('none');
    expect(noteChangeKind('', '依据')).toBe('added');
    expect(noteChangeKind('旧依据', '新依据')).toBe('changed');
    expect(noteChangeKind('旧依据', '')).toBe('cleared');
  });
  it('保留首尾空白差异这一事实', () => {
    expect(noteChangeKind('依据', ' 依据 ')).toBe('changed');
  });
  it('支持多行、中文、数字和特殊字符', () => {
    expect(noteChangeKind('', '第一行\n第二行：中文 123 / %')).toBe('added');
    expect(noteChangeKind('第一行\n第二行', '第一行\n第二行！')).toBe('changed');
  });
  it('按五种变动类型正确分类，且分类可重叠', () => {
    const changes = [
      { before: value(1), after: value(2) },
      { before: value(1), after: value(1, null, '', '新增') },
      { before: value(1, null, '=A1'), after: value(1, null, '=B1') },
      { before: value(1), after: value(2, null, '', '同时变动') },
    ];
    expect(checkpointChangeFlags(changes[0])).toMatchObject({ valueOnly: true, mixed: false });
    expect(filterCheckpointChanges(changes, 'value')).toHaveLength(1);
    expect(filterCheckpointChanges(changes, 'note')).toHaveLength(2);
    expect(filterCheckpointChanges(changes, 'formula')).toHaveLength(1);
    expect(filterCheckpointChanges(changes, 'mixed')).toHaveLength(1);
    expect(filterCheckpointChanges(changes, 'all')).toHaveLength(4);
  });
  it('组件渲染新增、清空、长文本和公式前后文', () => {
    const added = renderToStaticMarkup(<NoteDiff before="" after={'第一行\n第二行'} />);
    expect(added).toContain('新增附注');
    expect(added).toContain('第一行');
    expect(added).toContain('展开全文');
    expect(renderToStaticMarkup(<NoteDiff before="旧依据" after="" />)).toContain('清空附注');
    const formula = renderToStaticMarkup(<FormulaDiff before="=A1" after="=B1" />);
    expect(formula).toContain('公式已修改');
    expect(formula).toContain('=A1');
    expect(formula).toContain('=B1');
  });
});

describe('quantityText(定稿对比数量展示)', () => {
  it('空值显示占位符,零显示 0,非零按 formatQuantity 去尾零', () => {
    expect(quantityText(null)).toBe('—');
    expect(quantityText(0)).toBe('0');
    expect(quantityText(12_345_678)).toBe('1,234.5678');
    expect(quantityText(15_000)).toBe('1.5');
    // 最小缩放单位不再被默认小数位吞掉
    expect(quantityText(1)).toBe('0.0001');
    expect(quantityText(-1)).toBe('-0.0001');
  });
});
