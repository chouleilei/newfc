import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AutoComplete, Input, Typography, type AutoCompleteProps } from 'antd';
import { searchApi } from '../api/search';

/**
 * 顶栏检索(AC-F26):输入时联想编码/标题完全相同或前缀命中的条目(后端按权限与组织范围裁剪),
 * 空输入时列出可检索的类型;回车进入 /search?q= 做完整检索。
 */
export function HeaderSearch() {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => { const t = setTimeout(() => setDebounced(text.trim()), 250); return () => clearTimeout(t); }, [text]);
  const q = useQuery({ queryKey: ['search-suggest', debounced], queryFn: () => searchApi.suggestions(debounced), enabled: open, staleTime: 30_000 });
  const data = q.data;
  const options: NonNullable<AutoCompleteProps['options']> = !data ? [] : debounced
    ? data.items.map((i) => ({
      value: `${i.type}:${i.id}`, path: i.path,
      label: <span><Typography.Text type="secondary" style={{ fontSize: 12 }}>{i.typeLabel}</Typography.Text> {i.code ? `${i.code} ` : ''}{i.title}</span>,
    }))
    : [{
      label: <Typography.Text type="secondary" style={{ fontSize: 12 }}>可检索:{data.types.map((t) => t.label).join('、')}</Typography.Text>,
      options: data.types.map((t) => ({ value: `type:${t.type}`, disabled: true, path: '', label: <span>{t.label} <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t.hint}</Typography.Text></span> })),
    }];
  const go = (v: string) => { const k = v.trim(); if (k) { setOpen(false); navigate(`/search?q=${encodeURIComponent(k)}`); } };
  return (
    <AutoComplete
      value={text} options={options} open={open && options.length > 0} popupMatchSelectWidth={360}
      onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
      onSearch={setText}
      onSelect={(_v, o) => { const path = (o as { path?: string }).path; if (path) { setOpen(false); setText(''); navigate(path); } }}
      className="bd-header-search" style={{ width: 220 }}
    >
      <Input.Search size="small" allowClear maxLength={64} placeholder="检索项目、合同、报告…" aria-label="跨域检索" onSearch={go} />
    </AutoComplete>
  );
}
