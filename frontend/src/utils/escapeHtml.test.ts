import { describe, expect, it } from 'vitest';
import { escapeHtml } from './escapeHtml';

describe('escapeHtml', () => {
  it('转义五个 HTML 敏感字符', () => {
    expect(escapeHtml(`<img src=x onerror="alert('1')">`))
      .toBe('&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('普通文本原样返回,空值安全', () => {
    expect(escapeHtml('华东大区-2026')).toBe('华东大区-2026');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(123)).toBe('123');
  });

  it('先转义 & 再转义其他字符,不会二次展开', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});
