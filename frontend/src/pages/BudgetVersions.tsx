import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Card, Button, Modal, Form, Input, InputNumber, Select, Space, App, Tag, Typography, Result, Tooltip, Grid, Dropdown } from 'antd';
import { useNavigate } from 'react-router-dom';
import type { MenuProps, TableProps } from 'antd';
import { api, download } from '../api/client';
import { errorText } from '../components/TreeNodePage';
import { BdEmpty } from '../components/BdEmpty';
import { centsToWan } from '../utils/money';
import { EnhancedTable } from '../components/EnhancedTable';
import { useAssistantPageContext } from '../assistant/contextHooks';
import { useUrlScopeSync } from '../hooks/useUrlScopeSync';
import type { ScopeIssue } from '../utils/workspaceScope';
import { QualityReportContent, type QualityReportData } from './budgetEdit/QualityReport';
import { FinalizeConfirmModal, SetCurrentConfirmModal, kindLabel } from './budgetEdit/VersionLifecycleConfirm';

export interface VersionRow {
  id: number;
  year: number;
  name: string;
  status: 'draft' | 'locked' | 'archived';
  is_current: 0 | 1;
  kind: 'budget' | 'forecast';
  source_version_id: number | null;
  note: string;
  created_at: string;
  locked_at: string | null;
}

const STATUS_TAG: Record<string, { color: string; text: string }> = {
  draft: { color: 'gold', text: '草稿' },
  locked: { color: 'green', text: '定稿' },
  archived: { color: 'default', text: '归档' },
};

export default function BudgetVersions() {
  const qc = useQueryClient();
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const screens = Grid.useBreakpoint();
  /** 窄屏收窄头部操作:Card 的 title+extra 是不换行的 flex,三个固定宽度控件会把整页撑出横向滚动 */
  const compactActions = screens.sm === false;
  const [yearFilter, setYearFilter] = useState<number | undefined>();

  /* URL 范围契约(UX-02):年度筛选进 URL(?year=),刷新/书签恢复同一筛选;
     非法年度给出可见说明并忽略(筛选是只读条件,回落到「全部」不影响数据)。
     issues 锁存到本地 state 由用户关闭:URL 自愈改写后的再解析不应清掉说明。 */
  const [scopeIssues, setScopeIssues] = useState<ScopeIssue[]>([]);
  useUrlScopeSync('budget_versions', { year: yearFilter }, (parsed) => {
    if (parsed.scope.year != null) setYearFilter((prev) => (prev === parsed.scope.year ? prev : parsed.scope.year));
    if (parsed.issues.length > 0) {
      setScopeIssues((prev) => [...prev, ...parsed.issues.filter((issue) => !prev.some((p) => p.key === issue.key && p.raw === issue.raw))]);
    }
  });

  /* 小澧助手页面登记(§7.2 budget_versions)：年度筛选。 */
  useAssistantPageContext({ pageKey: 'budget_versions', ready: true, scope: { year: yearFilter }, view: {} });
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm();
  const [nameModal, setNameModal] = useState<{ id:number; mode:'rename'|'copy'; initial:string } | null>(null);
  const [nameForm] = Form.useForm<{ name:string }>();
  const [archivedOpen, setArchivedOpen] = useState(false);

  const { data: versions, error: versionsError, refetch: refetchVersions } = useQuery({
    queryKey: ['versions', yearFilter],
    queryFn: () => api.get<VersionRow[]>(`/versions${yearFilter ? `?year=${yearFilter}` : ''}`),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['versions'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const create = useMutation({
    mutationFn: (v: { year: number; name: string; kind: 'budget' | 'forecast'; note?: string; baseFrom?: 'budget' | 'actual'; baseYear?: number; growthRate?: string }) => api.post<VersionRow>('/versions', v),
    /* UX-06:创建成功直接进入新草稿的「全部科目」编制视图,无需再回列表找行 */
    onSuccess: (created) => { message.success('草稿已创建，可以开始编制'); setCreateOpen(false); invalidate(); navigate(`/budget/${created.id}?sheet=all`); },
    onError: (e) => message.error(errorText(e)),
  });

  const action = useMutation({
    mutationFn: ({ id, act, body }: { id: number; act: string; body?: unknown }) => api.post<VersionRow>(`/versions/${id}/${act}`, body),
    onSuccess: (_d, v) => { message.success('操作成功'); invalidate(); if (v.act === 'copy') navigate(`/budget/${_d.id}?sheet=all`); },
    onError: (e) => message.error(errorText(e)),
  });

  const del = useMutation({
    mutationFn: (id: number) => api.del(`/versions/${id}`),
    onSuccess: () => { message.success('已删除'); invalidate(); },
    onError: (e) => message.error(errorText(e)),
  });

  const rename = useMutation({
    mutationFn: ({ id, name, note }: { id: number; name?: string; note?: string }) => api.patch(`/versions/${id}`, { name, note }),
    onSuccess: () => { message.success('已保存'); invalidate(); },
    onError: (e) => message.error(errorText(e)),
  });

  /* ---------- UX-07 定稿/采用确认(与预算编辑页共用同一确认组件,均携带条件校验字段) ---------- */
  const [finalizeTarget, setFinalizeTarget] = useState<{ version: VersionRow; revision: number; quality: QualityReportData } | null>(null);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [finalizePending, setFinalizePending] = useState(false);
  const [adoptTarget, setAdoptTarget] = useState<{ version: VersionRow; previousCurrent: { id: number; name: string } | null } | null>(null);
  const [adoptError, setAdoptError] = useState<string | null>(null);
  const [adoptPending, setAdoptPending] = useState(false);

  /** 定稿入口:取最新修订号 + 完整质量报告;存在阻塞项时直接展示,不进入确认 */
  const openFinalize = async (v: VersionRow) => {
    try {
      const [detail, quality] = await Promise.all([
        api.get<VersionRow & { revision: number }>(`/versions/${v.id}`),
        api.get<QualityReportData>(`/versions/${v.id}/quality`),
      ]);
      if (!quality.canFinalize) {
        modal.error({
          title: '定稿前检查未通过',
          width: 780,
          content: (
            <QualityReportContent
              quality={quality}
              onLocate={(orgId, accountId) => navigate(`/budget/${v.id}?orgId=${orgId}&accountId=${accountId}`)}
            />
          ),
        });
        return;
      }
      setFinalizeError(null);
      setFinalizeTarget({ version: v, revision: detail.revision, quality });
    } catch (e) {
      message.error(`定稿前检查失败,未做任何修改:${errorText(e)}`);
    }
  };

  const confirmFinalize = async () => {
    if (!finalizeTarget) return;
    setFinalizePending(true);
    try {
      /* expectedRevision 由后端在事务内复核(UX-07) */
      await api.post(`/versions/${finalizeTarget.version.id}/lock`, { expectedRevision: finalizeTarget.revision });
      const done = finalizeTarget.version;
      setFinalizeTarget(null);
      setFinalizeError(null);
      message.success(`「${done.name}」已定稿`);
      invalidate();
      /* 定稿不自动采用:给出明确下一步 */
      modal.confirm({
        title: '定稿完成，接下来？',
        content: `「${done.name}」已定稿且内容冻结；定稿不会改变当前采用版本。`,
        okText: `设为当前${kindLabel(done.kind)}`,
        cancelText: '查看这一版',
        onOk: () => openAdopt(done),
        onCancel: () => navigate(`/budget/${done.id}`),
      });
    } catch (e) {
      /* 409 等:后端原因内联展示并保留弹窗,同时刷新列表让确认方看到最新状态 */
      setFinalizeError(errorText(e));
      invalidate();
    } finally {
      setFinalizePending(false);
    }
  };

  /** 采用入口:从已加载列表取该年度同用途的原采用版本(null=无),作为复核基线 */
  const openAdopt = (v: VersionRow) => {
    const prev = (versions ?? []).find((x) => x.year === v.year && x.kind === v.kind && x.is_current === 1 && x.id !== v.id);
    setAdoptError(null);
    setAdoptTarget({ version: v, previousCurrent: prev ? { id: prev.id, name: prev.name } : null });
  };

  const confirmAdopt = async () => {
    if (!adoptTarget) return;
    setAdoptPending(true);
    try {
      /* expectedCurrentVersionId 由后端在事务内复核(UX-07) */
      await api.post(`/versions/${adoptTarget.version.id}/set-current`, { expectedCurrentVersionId: adoptTarget.previousCurrent?.id ?? null });
      message.success(`已设为当前${kindLabel(adoptTarget.version.kind)}`);
      setAdoptTarget(null);
      invalidate();
    } catch (e) {
      setAdoptError(errorText(e));
      invalidate();
    } finally {
      setAdoptPending(false);
    }
  };

  const years = [...new Set((versions ?? []).map((v) => v.year))].sort((a, b) => b - a);

  /* UX-07:状态(草稿/定稿/归档)与「当前采用」是两个独立事实,分列展示;
     归档版本只读意义为主,移出主表放入可展开的历史区域。 */
  const activeVersions = (versions ?? []).filter((v) => v.status !== 'archived');
  const archivedVersions = (versions ?? []).filter((v) => v.status === 'archived');

  /* 主次分级(方案三.3):编制/查看常驻,其余收进「更多」下拉。危险动作在菜单内改为确认弹窗。
     音量守恒修订(《视觉高级感提升方案》3.6③):行级一律 default,全页唯一 primary 归页头「创建版本」。 */
  const versionColumns: NonNullable<TableProps<VersionRow>['columns']> = [
    { title: '年度', dataIndex: 'year', width: 80 },
    { title: '用途', dataIndex: 'kind', width: 80, render: (v: string) => <Tag color={v === 'forecast' ? 'purple' : 'blue'}>{v === 'forecast' ? '全年预测' : '年度预算'}</Tag> },
    /* 12 字版本名 ≈168px:160 放不下折两行;200 整行放下,超长省略 + Tooltip */
    { title: '版本名称', dataIndex: 'name', width: 200, ellipsis: { showTitle: false }, render: (v: string) => <Tooltip title={v}>{v}</Tooltip> },
    {
      title: '状态', dataIndex: 'status', width: 90,
      render: (s: string) => {
        /* 未知 status(接口演进/脏数据)不取 .color 崩溃,降级为原样展示 */
        const cfg = STATUS_TAG[s] ?? { color: 'default', text: s };
        return <Tag color={cfg.color}>{cfg.text}</Tag>;
      },
    },
    {
      title: '当前采用', dataIndex: 'is_current', width: 96,
      render: (v: number, row: VersionRow) => (v ? <Tag color={row.kind === 'forecast' ? 'purple' : 'blue'}>当前{row.kind === 'forecast' ? '预测' : '预算'}</Tag> : '-'),
    },
    { title: '备注', dataIndex: 'note', ellipsis: true },
    { title: '创建时间', dataIndex: 'created_at', width: 160, render: (v: string) => v.slice(0, 19).replace('T', ' ') },
    {
      title: '操作', width: 200,
      render: (_, v: VersionRow) => (
        <Space size={4}>
          {/* 草稿是可行动项:主色填充与「当前」标签同级,让「哪个版本需要我」3 秒可扫;
              不带 ?sheet= 以便恢复该版本上次使用的视图(UX-06) */}
          <Button size="small" type={v.status === 'draft' ? 'primary' : 'default'} onClick={() => navigate(`/budget/${v.id}`)}>
            {v.status === 'draft' ? '编制' : '查看'}
          </Button>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                v.status === 'draft' && {
                  key: 'rename',
                  label: '改名',
                  onClick: () => {
                    nameForm.setFieldsValue({ name: v.name });
                    setNameModal({ id: v.id, mode: 'rename', initial: v.name });
                  },
                },
                v.status === 'draft' && {
                  key: 'lock',
                  label: '定稿',
                  title: '通过定稿前检查后锁定为定稿版本',
                  onClick: () => void openFinalize(v),
                  disabled: action.isPending || finalizePending,
                },
                v.status === 'locked' && !v.is_current && {
                  key: 'set-current',
                  label: `设为当前${v.kind === 'forecast' ? '预测' : '预算'}`,
                  onClick: () => openAdopt(v),
                  disabled: action.isPending || adoptPending,
                },
                v.status === 'locked' && {
                  key: 'copy',
                  label: '基于此版继续编制',
                  onClick: () => {
                    nameForm.setFieldsValue({ name: `${v.name}-修订` });
                    setNameModal({ id: v.id, mode: 'copy', initial: `${v.name}-修订` });
                  },
                },
                v.status === 'locked' && !v.is_current && {
                  key: 'archive',
                  label: '归档',
                  danger: false,
                  onClick: () => modal.confirm({
                    title: '归档后仅可查看,继续?',
                    onOk: () => action.mutate({ id: v.id, act: 'archive' }),
                  }),
                  disabled: action.isPending,
                },
                {
                  key: 'export',
                  label: '导出明细',
                  onClick: () => download(`/io/export/budget-detail/${v.id}`, `预算明细-${v.year}-${v.name}.xlsx`),
                },
                { type: 'divider' },
                v.status === 'draft' && {
                  key: 'delete',
                  label: '删除',
                  danger: true,
                  onClick: () => modal.confirm({
                    title: '删除整个草稿版本及明细?',
                    okText: '删除',
                    okButtonProps: { danger: true },
                    onOk: () => del.mutate(v.id),
                  }),
                  disabled: del.isPending,
                },
              ].filter(Boolean) as MenuProps['items'],
            }}
          >
            <Button size="small" icon={<i className="ri-more-2-fill" aria-hidden />}>更多</Button>
          </Dropdown>
        </Space>
      ),
    },
  ];

  return (
    /* 无壳 + 无标题:本页挂载在 /budget 路由下,顶栏已显示「预算与预测」 */
    <Card
      className="bd-root-card"
      extra={
        <Space wrap size={4}>
          <Select
            allowClear
            placeholder="按年度筛选"
            style={{ width: compactActions ? 104 : 120 }}
            value={yearFilter}
            onChange={setYearFilter}
            options={years.map((y) => ({ value: y, label: `${y} 年` }))}
          />
          {/* 测算模板原在侧栏占一行,已收为本页入口:它是编制的前置配置,
              与版本列表是同一工作流,分开反而不易找。 */}
          <Button icon={<i className="ri-calculator-line" aria-hidden />} onClick={() => navigate('/data?tab=calculations')}>{compactActions ? '模板' : '测算模板'}</Button>
          <Button type="primary" icon={<i className="ri-add-line" aria-hidden />} onClick={() => { form.resetFields(); setCreateOpen(true); }}>{compactActions ? '新建' : '创建版本'}</Button>
        </Space>
      }
    >
      {scopeIssues.length > 0 && (
        <Alert
          type="warning"
          showIcon
          closable
          style={{ marginBottom: 12 }}
          onClose={() => setScopeIssues([])}
          message="链接中的范围参数已忽略"
          description={scopeIssues.map((issue) => issue.detail).join('；')}
        />
      )}
      {/* 机制说明收敛为一行 + Tooltip:原文 66 字常驻首屏,把版本表挤到折叠线以下。 */}
      <Space size={6} style={{ marginBottom: 12 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          预算与预测复用同一套编制与定稿机制
        </Typography.Text>
        <Tooltip title="预算与全年预测复用同一套编制、记录、定稿和快照机制；每个年度的预算与预测各自维持一个当前采用版本。草稿实时自动保存；定稿只冻结内容、不自动成为当前采用，后续修订通过「复制」生成新草稿。">
          <i className="ri-information-line" style={{ color: 'var(--bd-text-tertiary)', fontSize: 13, cursor: 'pointer' }} aria-hidden />
        </Tooltip>
      </Space>
      {versionsError ? <Result status="error" title="版本加载失败" subTitle={versionsError instanceof Error ? versionsError.message : String(versionsError)} extra={<Button type="primary" onClick={() => void refetchVersions()}>重试</Button>} /> : <>
        <EnhancedTable
          tableKey="budget-versions"
          title="预算版本"
          rowKey="id"
          loading={!versions}
          dataSource={activeVersions}
          locale={{
            emptyText: yearFilter != null
              ? <BdEmpty kind="search" description={`没有 ${yearFilter} 年的预算或预测版本`} onClearFilters={() => setYearFilter(undefined)} />
              : <BdEmpty kind="data" description="还没有预算或预测版本">
                  <Button type="primary" size="small" style={{ marginTop: 8 }} onClick={() => { form.resetFields(); setCreateOpen(true); }}>创建版本</Button>
                </BdEmpty>,
          }}
          columns={versionColumns}
        />
        {archivedVersions.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <Button type="text" size="small" onClick={() => setArchivedOpen((v) => !v)}>
              <i className={archivedOpen ? 'ri-arrow-down-s-line' : 'ri-arrow-right-s-line'} aria-hidden /> 历史归档（{archivedVersions.length}）
            </Button>
            {archivedOpen && (
              <EnhancedTable
                tableKey="budget-versions-archived"
                title="已归档版本（只读）"
                rowKey="id"
                dataSource={archivedVersions}
                columns={versionColumns}
              />
            )}
          </div>
        )}
      </>}

      <Modal
        title="创建预算或全年预测草稿"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => form.validateFields().then(async (v) => {
          const payload = {
            ...v,
            growthRate: v.growthRate != null ? String(v.growthRate / 100) : undefined,
          };
          if (!payload.baseFrom) {
            create.mutate(payload);
            return;
          }
          let preview: {
            sourceLabel: string; sourceCount: number; generatedCount: number; skippedCount: number;
            sourceAmountCents: number; generatedAmountCents: number;
          };
          try {
            preview = await api.post('/versions/generation-preview', payload);
          } catch (e) {
            message.error(errorText(e));
            return;
          }
          modal.confirm({
            title: '初稿生成预览',
            content: (
              <div>
                <div>来源：{preview.sourceLabel}</div>
                <div>可生成 {preview.generatedCount} 条；因当前树结构不适用跳过 {preview.skippedCount} 条。</div>
                <div>利润方向净额：{centsToWan(preview.sourceAmountCents)} → {centsToWan(preview.generatedAmountCents)} 万元。</div>
              </div>
            ),
            onOk: () => create.mutate(payload),
          });
        })}
        confirmLoading={create.isPending}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="year" label="预算年度" rules={[{ required: true }]} initialValue={new Date().getFullYear()}>
            <InputNumber style={{ width: '100%' }} min={1900} max={9999} />
          </Form.Item>
          <Form.Item name="kind" label="版本用途" rules={[{ required: true }]} initialValue="budget">
            <Select options={[{ value: 'budget', label: '年度预算' }, { value: 'forecast', label: '全年预测' }]} />
          </Form.Item>
          <Form.Item name="name" label="版本名称" rules={[{ required: true }]}>
            <Input placeholder="如 年初版 / 年中调整版" />
          </Form.Item>
          <Form.Item name="baseFrom" label="生成初始草稿数据(可选:同比/增量预算生成)">
            <Select
              allowClear
              placeholder="空白版本(从零编制)"
              options={[
                { value: 'budget', label: '从上年预算复制生成(以生效版本为底稿)' },
                { value: 'actual', label: '从上年实际数复制生成(以当前累计为底稿)' },
              ]}
            />
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(prev, cur) => prev.baseFrom !== cur.baseFrom}
          >
            {({ getFieldValue }) =>
              getFieldValue('baseFrom') ? (
                <Space style={{ display: 'flex', marginBottom: 16 }} align="start">
                  <Form.Item name="growthRate" label="增长系数(%)" initialValue={0} extra="例: 5 表示在上年基础上增长 5%, -3 表示下调 3%">
                    <InputNumber style={{ width: 180 }} addonAfter="%" step={1} />
                  </Form.Item>
                </Space>
              ) : null
            }
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal title={nameModal?.mode === 'copy' ? '复制版本' : '修改版本名称'} open={!!nameModal} onCancel={() => setNameModal(null)} confirmLoading={nameModal?.mode === 'copy' ? action.isPending : rename.isPending} onOk={() => nameForm.validateFields().then(v => { if (!nameModal) return; if (nameModal.mode === 'copy') action.mutate({ id:nameModal.id, act:'copy', body:{ name:v.name } }, { onSuccess:()=>setNameModal(null) }); else rename.mutate({ id:nameModal.id, name:v.name }, { onSuccess:()=>setNameModal(null) }); })}>
        <Form form={nameForm} layout="vertical"><Form.Item name="name" label="版本名称" rules={[{required:true}]}><Input /></Form.Item></Form>
      </Modal>

      {/* UX-07 定稿/采用确认:与预算编辑页共用同一组件 */}
      {finalizeTarget && (
        <FinalizeConfirmModal
          open
          version={finalizeTarget.version}
          quality={finalizeTarget.quality}
          confirmPending={finalizePending}
          error={finalizeError}
          onLocate={(orgId, accountId) => {
            setFinalizeTarget(null);
            setFinalizeError(null);
            navigate(`/budget/${finalizeTarget.version.id}?orgId=${orgId}&accountId=${accountId}`);
          }}
          onConfirm={() => void confirmFinalize()}
          onCancel={() => { setFinalizeTarget(null); setFinalizeError(null); }}
        />
      )}
      {adoptTarget && (
        <SetCurrentConfirmModal
          open
          version={adoptTarget.version}
          previousCurrent={adoptTarget.previousCurrent}
          confirmPending={adoptPending}
          error={adoptError}
          onConfirm={() => void confirmAdopt()}
          onCancel={() => { setAdoptTarget(null); setAdoptError(null); }}
        />
      )}
    </Card>
  );
}
