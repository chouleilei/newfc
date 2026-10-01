import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntdApp, Button, Input, List, Space, Typography } from 'antd';
import { can, errorText } from '../../api/client';
import { promptSupplementApi, type PromptSupplementDto } from '../../api/systemSettings';

/** 与后端 PROMPT_SUPPLEMENT_MAX 一致(契约只做类型导入)。 */
const PROMPT_SUPPLEMENT_MAX = 1000;
import { QueryErrorResult } from '../../components/QueryErrorResult';
import { shortTime } from '../../utils/relativeTime';

function Item({ item, writable }: { item: PromptSupplementDto; writable: boolean }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (content: string) => promptSupplementApi.save(item.taskKey, { content, expectedVersion: item.version }),
    onSuccess: () => { message.success('已保存'); setDraft(null); void qc.invalidateQueries({ queryKey: ['prompt-supplements'] }); },
    onError: (e) => message.error(errorText(e)),
  });
  const editing = draft !== null;
  return (
    <List.Item>
      <Space direction="vertical" style={{ width: '100%' }} size={4}>
        <Space wrap>
          <Typography.Text strong>{item.label}</Typography.Text>
          <Typography.Text type="secondary" code>{item.effectivePromptVersion}</Typography.Text>
          {item.updatedAt && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{item.updatedBy ?? ''} 更新于 {shortTime(item.updatedAt)}</Typography.Text>}
        </Space>
        {editing ? (
          <>
            <Input.TextArea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} maxLength={PROMPT_SUPPLEMENT_MAX} showCount placeholder="如:整改建议按“责任部门—完成时限”组织;用语简洁正式。" />
            <Space>
              <Button type="primary" size="small" loading={save.isPending} onClick={() => save.mutate(draft)}>保存</Button>
              <Button size="small" onClick={() => setDraft(null)}>取消</Button>
            </Space>
          </>
        ) : (
          <Space align="start">
            <Typography.Paragraph type={item.content ? undefined : 'secondary'} style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{item.content || '未设置'}</Typography.Paragraph>
            {writable && <Button size="small" type="link" onClick={() => setDraft(item.content)}>编辑</Button>}
            {writable && item.content && <Button size="small" type="link" danger loading={save.isPending} onClick={() => save.mutate('')}>清空</Button>}
          </Space>
        )}
      </Space>
    </List.Item>
  );
}

/** T-7 AI 提示补充(AC-F23):按改写任务追加业务补充说明;硬约束与数字守卫不变,补充变化体现在 prompt 版本里。 */
export default function PromptSupplementsPanel() {
  const writable = can('settings:manage');
  const q = useQuery({ queryKey: ['prompt-supplements'], queryFn: () => promptSupplementApi.list() });
  if (q.error) return <QueryErrorResult title="提示补充加载失败" error={q.error} refetch={q.refetch} />;
  return (
    <>
      <Alert type="info" showIcon style={{ marginBottom: 8 }}
        message="补充说明附在系统硬约束之后,只影响行文风格与关注点;不能放开“不得改动数字、编码、名称”等约束,改写稿仍经事实守卫校验,不通过即退回模板稿。" />
      <List loading={q.isLoading} dataSource={q.data?.items ?? []} renderItem={(item) => <Item key={`${item.taskKey}:${item.version}`} item={item} writable={writable} />} />
    </>
  );
}
