import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntdApp, Button, Card, Descriptions, Drawer, Input, List, Modal, Popconfirm, Select, Space, Spin, Tag, Typography } from 'antd';
import { api, ApiError } from '../api/client';
import { QueryErrorResult } from '../components/QueryErrorResult';
import { type AssistantInsightRow, type InsightKind } from '@contracts/assistant';
import { assistantApi } from '../api/assistant';
import { CitationList, FactsPanel, factLabel } from '../components/assistant/FactsPanel';
import { InsightKindPicker } from '../components/InsightKindPicker';
import { INSIGHT_KINDS } from './assistantShared/insightKinds';
import { useAssistantPageContext } from '../assistant/contextHooks';

/**
 * 洞察报告中心:洞察列表/详情/删除/新建。
 * 注意:洞察的读写走 /api/assistant/* 端点,受助手限流约束(既有行为,本期不改)。
 * 洞察内容由后端按参数重新计算并附结构化引用,不保存前端传入的数字。
 */
export default function Insights() {
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const [detailId, setDetailId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [kind, setKind] = useState<InsightKind>('execution');
  const [title, setTitle] = useState('');
  const [versionId, setVersionId] = useState<number | undefined>();
  const [targetVersionId, setTargetVersionId] = useState<number | undefined>();
  const [year, setYear] = useState<number | undefined>();

  const { data, isLoading, isError, error: listError, refetch: refetchList } = useQuery({
    queryKey: ['assistant-insights'],
    queryFn: () => assistantApi.insights(),
  });

  /* 财务助手页面登记(§7.2 insights)：打开详情时把 insightId 纳入范围。
     读取失败同样不算就绪——错误态宣称「已对齐」会误导用户(§3.7)。 */
  useAssistantPageContext({
    pageKey: 'insights',
    ready: !isLoading && !isError,
    readyState: isLoading ? 'loading' : 'error',
    notReadyReason: isError ? '洞察列表读取失败' : '正在读取洞察列表',
    scope: { insightId: detailId ?? undefined },
    view: {},
  });
  const { data: detail, error: detailError, refetch: refetchDetail } = useQuery({
    queryKey: ['assistant-insight', detailId],
    queryFn: () => assistantApi.insight(detailId as number),
    enabled: detailId != null,
  });
  const { data: versions, error: versionsError, refetch: refetchVersions } = useQuery({
    queryKey: ['versions'],
    queryFn: () => api.get<{ id: number; year: number; name: string; status: string; is_current: 0 | 1 }[]>('/versions'),
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['assistant-insights'] });
  const deleteMutation = useMutation({
    mutationFn: (id: number) => assistantApi.deleteInsight(id),
    onSuccess: () => {
      message.success('洞察已删除');
      setDetailId(null);
      invalidate();
    },
    onError: (err) => message.error(err instanceof ApiError ? err.body.message : '删除失败'),
  });
  const saveMutation = useMutation({
    mutationFn: () => {
      const config = INSIGHT_KINDS.find((row) => row.value === kind)!;
      const params: Record<string, unknown> = {};
      if (config.needs === 'version') {
        if (versionId == null) throw new Error('该类型需要选择预算版本');
        params.versionId = versionId;
      }
      if (config.needs === 'year') {
        if (year == null) throw new Error('该类型需要选择年度');
        params.year = year;
      }
      if (config.needs === 'compare') {
        if (versionId == null || targetVersionId == null) throw new Error('版本对比需要同时选择预算版本与对比版本');
        params.baseVersionId = versionId;
        params.targetVersionId = targetVersionId;
      }
      return assistantApi.saveInsight({
        kind,
        params,
        title: title.trim() || `${config.label}（${new Date().toLocaleString('zh-CN')}）`,
      });
    },
    onSuccess: (saved) => {
      message.success(`洞察已保存 #${saved.id},数字由后端重新计算并附引用`);
      setCreateOpen(false);
      setTitle('');
      invalidate();
    },
    onError: (err) => message.error(err instanceof ApiError ? err.body.message : err instanceof Error ? err.message : '保存洞察失败'),
  });

  const config = INSIGHT_KINDS.find((row) => row.value === kind)!;
  const years = [...new Set((versions ?? []).map((v) => v.year))].sort((a, b) => b - a);

  return (
    <Card className="newfc-root-card">
      <Space style={{ marginBottom: 12 }} wrap>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          洞察的生成与删除走助手服务、受助手限流约束(既有行为);数字由后端按参数重新计算并附引用。
        </Typography.Text>
        <Button type="primary" size="small" icon={<i className="ri-add-line" aria-hidden />} onClick={() => setCreateOpen(true)}>新建洞察</Button>
      </Space>
      {isLoading ? <Spin /> : isError ? (
        /* 失败不能显示「暂无洞察」:空态是成功查询的结论 */
        <QueryErrorResult title="洞察列表加载失败" error={listError} refetch={() => void refetchList()} />
      ) : (
        <List<AssistantInsightRow>
          dataSource={data?.items ?? []}
          locale={{ emptyText: '暂无洞察,点击「新建洞察」生成' }}
          renderItem={(item) => (
            <List.Item
              actions={[
                <Button key="view" size="small" type="link" onClick={() => setDetailId(item.id)}>查看</Button>,
                <Popconfirm key="del" title="删除该洞察?" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => deleteMutation.mutate(item.id)}>
                  <Button size="small" danger type="text" aria-label={`删除洞察 ${item.title}`} title="删除洞察" icon={<i className="ri-delete-bin-line" aria-hidden />} />
                </Popconfirm>,
              ]}
            >
              <List.Item.Meta
                title={<Button type="link" style={{ padding: 0 }} onClick={() => setDetailId(item.id)}>{item.title}</Button>}
                description={`生成时间 ${item.createdAt}`}
              />
            </List.Item>
          )}
        />
      )}

      <Modal
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => saveMutation.mutate()}
        okText="保存洞察"
        title="新建洞察"
        confirmLoading={saveMutation.isPending}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          {versionsError && (
            <Alert type="error" showIcon message="预算版本列表加载失败，暂不能选择版本" action={<Button size="small" onClick={() => void refetchVersions()}>重试</Button>} />
          )}
          <InsightKindPicker value={kind} onChange={setKind} />
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="洞察标题(可留空自动生成)" maxLength={200} />
          {config.needs === 'version' && (
            <Select
              placeholder="选择预算版本"
              style={{ width: '100%' }}
              value={versionId}
              onChange={setVersionId}
              options={(versions ?? []).map((v) => ({ value: v.id, label: `${v.year} · ${v.name}${v.is_current ? ' (当前)' : ''}` }))}
            />
          )}
          {config.needs === 'compare' && (
            <>
              <Select
                placeholder="选择预算版本"
                style={{ width: '100%' }}
                value={versionId}
                onChange={setVersionId}
                options={(versions ?? []).map((v) => ({ value: v.id, label: `${v.year} · ${v.name}` }))}
              />
              <Select
                placeholder="选择对比版本"
                style={{ width: '100%' }}
                value={targetVersionId}
                onChange={setTargetVersionId}
                options={(versions ?? []).map((v) => ({ value: v.id, label: `${v.year} · ${v.name}` }))}
              />
            </>
          )}
          {config.needs === 'year' && (
            <Select
              placeholder="选择年度"
              style={{ width: '100%' }}
              value={year}
              onChange={setYear}
              options={years.map((y) => ({ value: y, label: `${y} 年` }))}
            />
          )}
        </Space>
      </Modal>

      <Drawer
        open={detailId != null}
        onClose={() => setDetailId(null)}
        width="min(720px, 94vw)"
        title={detail ? detail.title : '洞察详情'}
        extra={detailId != null && (
          <Popconfirm title="删除该洞察?" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => deleteMutation.mutate(detailId)}>
            <Button size="small" danger icon={<i className="ri-delete-bin-line" aria-hidden />}>删除</Button>
          </Popconfirm>
        )}
      >
        {detailError ? (
          <QueryErrorResult title="洞察详情加载失败" error={detailError} refetch={() => void refetchDetail()} />
        ) : !detail ? <Spin /> : (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="类型">{factLabel(`insight:${detail.result?.kind}`)}</Descriptions.Item>
              <Descriptions.Item label="生成时间">{detail.result?.generatedAt ?? detail.created_at}</Descriptions.Item>
              <Descriptions.Item label="参数"><Typography.Text code style={{ fontSize: 12 }}>{JSON.stringify(detail.result?.params ?? {})}</Typography.Text></Descriptions.Item>
            </Descriptions>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12, marginRight: 6 }}>引用来源</Typography.Text>
              <CitationList citations={detail.citations ?? []} />
            </div>
            <FactsPanel facts={[{ type: `insight:${detail.result?.kind}`, data: detail.result?.summary, source: {} }]} />
          </Space>
        )}
      </Drawer>
    </Card>
  );
}
