import { useAssistantDomainPage } from '../assistant/contextHooks';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert, Card, Empty, Input, List, Select, Space, Spin, Tag, Typography } from 'antd';
import { QueryErrorResult } from '../components/QueryErrorResult';
import { shortTime } from '../utils/relativeTime';
import { SEARCH_TYPE_OPTIONS, searchApi, type SearchItemDto, type SearchType } from '../api/search';

/**
 * AC-F26 跨域检索:一个关键词同时查项目、供应商、合同、报销、项目预算批次、可研/投资/预测、风险、报告与经营预算版本。
 * 按编码/名称关键词匹配(不是语义检索),每类最多 20 条;结果与各页面同一权限与组织范围,点击进入对象所在页面。
 */

const LABEL = Object.fromEntries(SEARCH_TYPE_OPTIONS.map((o) => [o.value, o.label])) as Record<SearchType, string>;

export function groupByType(items: SearchItemDto[]): { type: SearchType; items: SearchItemDto[] }[] {
  const groups = new Map<SearchType, SearchItemDto[]>();
  for (const item of items) {
    const list = groups.get(item.type) ?? [];
    list.push(item);
    groups.set(item.type, list);
  }
  return SEARCH_TYPE_OPTIONS.filter((o) => groups.has(o.value)).map((o) => ({ type: o.value, items: groups.get(o.value)! }));
}

export default function Search() {
  const [params, setParams] = useSearchParams();
  const q = (params.get('q') ?? '').trim();
  const types = useMemo(
    () => (params.get('types') ?? '').split(',').filter((t): t is SearchType => t in LABEL),
    [params],
  );
  const update = (next: { q?: string; types?: SearchType[] }) => setParams((p) => {
    const n = new URLSearchParams(p);
    if (next.q !== undefined) { if (next.q.trim()) n.set('q', next.q.trim()); else n.delete('q'); }
    if (next.types !== undefined) { if (next.types.length) n.set('types', next.types.join(',')); else n.delete('types'); }
    return n;
  }, { replace: true });
  const result = useQuery({
    queryKey: ['cross-search', q, types.join(',')],
    queryFn: () => searchApi.search(q, types),
    enabled: q.length > 0,
  });
  const data = result.data;
  useAssistantDomainPage({ pageKey: 'search', ready: true, scope: {}, view: { keyword: q, types } });
  const groups = data ? groupByType(data.items) : [];
  return (
    <div>
      <div className="newfc-search-controls">
        <Input.Search key={q} allowClear autoFocus={!q} defaultValue={q} placeholder="编码、编号或名称" enterButton="检索" maxLength={64}
          style={{ width: 'min(360px, 100%)' }} onSearch={(v) => update({ q: v })} aria-label="检索关键词" />
        <Select mode="multiple" allowClear placeholder="全部类型" style={{ width: 'min(300px, 100%)' }} value={types} maxTagCount="responsive"
          options={SEARCH_TYPE_OPTIONS} onChange={(v: SearchType[]) => update({ types: v })} aria-label="检索类型" />
      </div>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        按编码/编号与名称关键词匹配(精确 → 前缀 → 包含),不是语义检索;每类最多 20 条,只返回您有权查看的对象。
      </Typography.Paragraph>
      {!q ? <Empty description="输入关键词开始检索" /> : result.error ? (
        <QueryErrorResult title="检索失败" error={result.error} refetch={result.refetch} />
      ) : result.isLoading || !data ? <Spin /> : (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {data.skipped.length > 0 && (
            <Alert type="info" showIcon message={`无查看权限,未检索:${data.skipped.map((t) => LABEL[t] ?? t).join('、')}`} />
          )}
          {groups.length === 0 ? <Empty description={`没有找到与「${data.query}」匹配的对象`} /> : groups.map((g) => (
            <Card key={g.type} size="small" title={<Space>{LABEL[g.type]}<Tag>{g.items.length}</Tag>{data.truncated[g.type] && <Typography.Text type="secondary" style={{ fontSize: 12 }}>结果较多,仅显示前 {g.items.length} 条,请细化关键词</Typography.Text>}</Space>}>
              <List<SearchItemDto>
                size="small" dataSource={g.items}
                renderItem={(item) => (
                  <List.Item extra={item.updatedAt ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{shortTime(item.updatedAt)}</Typography.Text> : null}>
                    <List.Item.Meta
                      title={<Link to={item.path}>{item.code ? <Typography.Text code>{item.code}</Typography.Text> : null} {item.title}</Link>}
                      description={<Space size={8} wrap>{item.orgName && <span>{item.orgName}</span>}<Tag>{item.status}</Tag>{item.subtitle && <span>{item.subtitle}</span>}</Space>}
                    />
                  </List.Item>
                )}
              />
            </Card>
          ))}
        </Space>
      )}
    </div>
  );
}
