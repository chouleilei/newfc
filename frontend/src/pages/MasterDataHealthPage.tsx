import { useQuery } from '@tanstack/react-query';
import { Card, Spin, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { MasterDataHealthContent, type MasterDataHealthReportData } from '../components/MasterDataHealth';
import { useAssistantPageContext } from '../assistant/contextHooks';

/**
 * 主数据健康体检独立页:直接复用 components/MasterDataHealth 的报告渲染,
 * 无需 Drawer。跨页定位目前降级为跳转到对应管理页(组织/科目),
 * 由用户在页内按编码检索;定位增强作为可选项留待后续。
 */
export default function MasterDataHealthPage() {
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['master-data-health'],
    queryFn: () => api.get<MasterDataHealthReportData>('/master-data/health'),
    staleTime: 30_000,
    retry: false,
  });

  /* 小澧助手页面登记(§7.2 master_health)：主数据健康无页面筛选，ready 跟随健康报告加载。 */
  useAssistantPageContext({ pageKey: 'master_health', ready: !query.isLoading && !query.isError, readyState: query.isLoading ? 'loading' : 'error', notReadyReason: query.isError ? '主数据健康报告读取失败' : '正在读取主数据健康报告', scope: {}, view: {} });

  return (
    <Card className="bd-root-card">
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        结构、命名与数据卫生的只读体检报告;处理动作(停用、改名、合并)请在组织/科目管理页执行。
        点击「定位」跳转到对应管理页后,可按编码检索目标节点。
      </Typography.Paragraph>
      {query.isLoading ? (
        <Spin />
      ) : query.data ? (
        <MasterDataHealthContent
          report={query.data}
          onLocateOrg={() => navigate('/org')}
          onLocateAccount={() => navigate('/account')}
        />
      ) : (
        <Typography.Text type="danger">体检报告加载失败</Typography.Text>
      )}
    </Card>
  );
}
