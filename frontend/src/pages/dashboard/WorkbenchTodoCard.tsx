import { useQuery } from '@tanstack/react-query';
import { Badge, Card, Space, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { can } from '../../api/client';
import { todoApi } from '../../api/projectContract';

/**
 * 工作台待办(T-4):合同待审核/待复核变更与付款/已批准待支付、报销待复核/退回补件。
 * 服务端按权限与组织范围计数,无权限的项不返回;没有任何项时不渲染。
 */
export function WorkbenchTodoCard() {
  const navigate = useNavigate();
  const allowed = can('dashboard:read');
  const q = useQuery({ queryKey: ['workbench-todos'], queryFn: () => todoApi.list(), enabled: allowed, retry: false, staleTime: 30_000 });
  const items = q.data?.items ?? [];
  if (!allowed || items.length === 0) return null;
  return (
    <div data-testid="workbench-todo-card">
      <div className="newfc-eyebrow">待办 / 项目合同与费用审核</div>
      <Card size="small">
        <Space size={[24, 12]} wrap>
          {items.map((it) => (
            <Typography.Link key={it.key} onClick={() => navigate(it.path)} aria-label={`${it.label} ${it.count}`}>
              <Space size={6}>
                <span>{it.label}</span>
                <Badge count={it.count} showZero color={it.count > 0 ? 'var(--newfc-accent)' : '#bfbfbf'} overflowCount={999} />
              </Space>
            </Typography.Link>
          ))}
        </Space>
      </Card>
    </div>
  );
}
