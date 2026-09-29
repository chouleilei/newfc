/**
 * 导入批次只读详情抽屉(方案《易用性与直觉化交互实施方案》§4.4/§4.9,任务 UX-19)。
 *
 * 消费 UX-14 的只读详情接口 GET /api/io/import-batches/:id:
 * - 状态/目标/期间/摘要复用 UX-15 的 ImportSummaryView;结果行按 年度×截止日×快照 业务化;
 * - 允许动作展示服务端门禁 allowed+reason:确认不在此处执行(确认有页面级编辑锁,
 *   请到原导入入口完成),取消预览/撤销已导入在此可执行,失败时展示服务端原因与更正路径,
 *   绝不把不可撤销伪装成可撤销;
 * - 有冻结明细(frozen-detail)时提供 preview-rows 分页明细(复用 ImportPreviewRowsTable,
 *   本抽屉为只读查看,不提供确认按钮);旧批次(legacy-summary)显示已有摘要并标注能力范围;
 * - 已提交批次给结果位置入口(复用 importResultLinks,预算版本/实际页/分析页快照),
 *   财务转换来源批次互链到「财务系统转换 → 批次历史与追溯」;
 * - 保留原文件名/文件指纹下载与「技术详情」折叠入口。
 *
 * 文案纪律:待确认批次只有「取消预览」,已提交批次只有「撤销已导入」,两者绝不共用按钮名。
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Descriptions, Drawer, Popconfirm, Space, Spin, Tag, Typography } from 'antd';
import { api, download, errorText } from '../api/client';
import {
  cancelImportBatch,
  getImportBatchDetail,
  listImportBatchPreviewRows,
  type ImportBatchDetail,
  type ImportPreviewRow,
  type PreviewAction,
} from '../api/importBatch';
import { invalidateAnalysisQueries } from '../utils/queryInvalidation';
import {
  describeImportResult,
  rollbackCorrectionAdvice,
} from '../utils/importBatchSummary';
import { ImportPreviewRowsTable, ImportSummaryView, importResultLinks } from './ImportPreviewPanel';
import { TechDetail } from './TechDetail';

const ROWS_PAGE_SIZE = 50;

/** 冻结明细只读查看(分页/筛选走服务端 preview-rows;无确认/取消交互)。 */
function FrozenRows({ batchId, detail }: { batchId: number; detail: ImportBatchDetail }) {
  const { message } = App.useApp();
  const [page, setPage] = useState(1);
  const [actionFilter, setActionFilter] = useState<PreviewAction | undefined>();
  const [orgFilter, setOrgFilter] = useState<number | undefined>();
  const [warningOnly, setWarningOnly] = useState(false);
  const [orgOptions, setOrgOptions] = useState<{ value: number; label: string }[]>([]);

  // 组织筛选选项:统一摘要给编码,preview-rows 按 orgId 过滤,经组织树映射(与 UX-15 面板同口径)
  useEffect(() => {
    if ((detail.preview?.orgScope.count ?? 0) <= 0) return;
    let cancelled = false;
    api.get<{ rows: { id: number; code: string }[] }>('/org/tree')
      .then((tree) => {
        if (cancelled) return;
        const idByCode = new Map(tree.rows.map((row) => [row.code, row.id] as const));
        setOrgOptions((detail.preview?.orgScope.codes ?? [])
          .filter((code) => idByCode.has(code))
          .map((code) => ({ value: idByCode.get(code)!, label: code })));
      })
      .catch(() => { /* 组织树不可用时仅不提供组织筛选下拉 */ });
    return () => { cancelled = true; };
  }, [detail]);

  const rowsQuery = useQuery<{ total: number; items: ImportPreviewRow[] }>({
    queryKey: ['import-batch-preview-rows', batchId, page, orgFilter, actionFilter, warningOnly],
    queryFn: () => listImportBatchPreviewRows(batchId, { page, pageSize: ROWS_PAGE_SIZE, orgId: orgFilter, action: actionFilter, warningOnly }),
  });
  useEffect(() => {
    if (rowsQuery.error) message.error(`冻结明细加载失败:${errorText(rowsQuery.error)}`);
  }, [rowsQuery.error, message]);

  return (
    <ImportPreviewRowsTable
      rows={rowsQuery.data?.items ?? []}
      total={rowsQuery.data?.total ?? 0}
      page={page}
      loading={rowsQuery.isFetching}
      actionFilter={actionFilter}
      orgFilter={orgFilter}
      warningOnly={warningOnly}
      orgOptions={orgOptions}
      onPageChange={setPage}
      onActionFilterChange={(value) => { setActionFilter(value); setPage(1); }}
      onOrgFilterChange={(value) => { setOrgFilter(value); setPage(1); }}
      onWarningOnlyChange={(checked) => { setWarningOnly(checked); setPage(1); }}
    />
  );
}

function GateTag({ gate }: { gate: { allowed: boolean; reason?: string } }) {
  return gate.allowed
    ? <Tag color="green">可执行</Tag>
    : <Tag>不可执行</Tag>;
}

export interface ImportBatchDetailDrawerProps {
  batchId: number | null;
  onClose: () => void;
}

export default function ImportBatchDetailDrawer({ batchId, onClose }: ImportBatchDetailDrawerProps) {
  const qc = useQueryClient();
  const { message, modal } = App.useApp();
  const detailQuery = useQuery({
    queryKey: ['import-batch-detail', batchId],
    enabled: batchId != null,
    queryFn: () => getImportBatchDetail(batchId!),
  });
  const detail = detailQuery.data ?? null;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['import-batch-detail', batchId] });
    qc.invalidateQueries({ queryKey: ['import-batches'] });
  };

  const cancelMutation = useMutation({
    mutationFn: (id: number) => cancelImportBatch(id),
    onSuccess: () => { message.success('预览已取消，未写入任何数据'); refresh(); },
    onError: (e) => message.error(errorText(e)),
  });

  const rollbackMutation = useMutation({
    mutationFn: (id: number) => api.post(`/io/import-batches/${id}/rollback`),
    onSuccess: () => {
      message.success('该批次导入已撤销，相关数据恢复到导入前');
      refresh();
      qc.invalidateQueries({ queryKey: ['actual-matrix'] });
      void invalidateAnalysisQueries(qc);
    },
    // 有后续修改时服务端明确拒绝:原因就地持续展示,并给更正路径,不伪装可撤销
    onError: (e) => {
      if (!detail) { message.error(errorText(e)); return; }
      modal.error({
        title: `批次 #${detail.id} 不能安全撤销`,
        content: `${errorText(e)}。${rollbackCorrectionAdvice(detail)}`,
      });
      refresh();
    },
  });

  const resultLines = detail ? describeImportResult(detail) : [];
  const financeConversionId = detail && typeof detail.summary.financeConversionId === 'number'
    ? detail.summary.financeConversionId
    : null;
  const pending = detail?.status === 'pending';
  const committed = detail?.status === 'committed';

  return (
    <Drawer
      title={batchId != null ? `导入批次详情 · #${batchId}` : '导入批次详情'}
      width="min(960px, 94vw)"
      open={batchId != null}
      onClose={onClose}
      destroyOnClose
    >
      {detailQuery.isError && (
        <Alert
          type="error" showIcon
          message="批次详情加载失败"
          description={errorText(detailQuery.error)}
          action={<Button size="small" onClick={() => void detailQuery.refetch()}>重试</Button>}
        />
      )}
      {!detail && !detailQuery.isError && <Spin style={{ display: 'block', margin: '48px auto' }} />}
      {detail && (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {/* 时间线与原文件(状态/来源/目标由下方 ImportSummaryView 统一承担) */}
          <Descriptions bordered size="small" column={2}>
            <Descriptions.Item label="创建时间">{detail.createdAt.slice(0, 19).replace('T', ' ')}</Descriptions.Item>
            <Descriptions.Item label="提交时间">{detail.committedAt ? detail.committedAt.slice(0, 19).replace('T', ' ') : '—'}</Descriptions.Item>
            {detail.rolledBackAt && (
              <Descriptions.Item label="撤销时间" span={2}>{detail.rolledBackAt.slice(0, 19).replace('T', ' ')}</Descriptions.Item>
            )}
            <Descriptions.Item label="原文件" span={2}>
              <Typography.Text style={{ fontSize: 12 }}>{detail.originalName}</Typography.Text>
              {detail.status !== 'cancelled' && (
                <Button
                  size="small" type="link"
                  onClick={() => download(`/io/import-batches/${detail.id}/source`, detail.originalName)}
                >下载原文件</Button>
              )}
            </Descriptions.Item>
          </Descriptions>

          {/* 业务摘要(与列表同一表达)+ 原始 JSON 折叠到技术详情 */}
          <ImportSummaryView detail={detail} />
          <TechDetail
            summary={<Typography.Text type="secondary" style={{ fontSize: 12 }}>摘要与结果原始字段</Typography.Text>}
            raw={JSON.stringify({ summary: detail.summary, result: detail.result }, null, 2)}
          />

          {/* 结果(已提交/已撤销)+ 结果位置入口 */}
          {resultLines.length > 0 && (
            <Alert
              type={detail.status === 'rolled_back' ? 'warning' : 'success'}
              showIcon
              message={detail.status === 'rolled_back' ? '该批次已撤销(结果行保留供追溯)' : '导入结果'}
              description={resultLines.map((line) => <div key={line}>{line}</div>)}
            />
          )}
          {committed && (
            <Space wrap>
              {importResultLinks(detail).map((link, index) => (
                <Link key={link.to + index} to={link.to}>{link.label}</Link>
              ))}
            </Space>
          )}
          {financeConversionId != null && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              本批次由财务转换生成：
              <Link to="/finance?tab=history">查看财务转换批次 #{financeConversionId}（批次历史与追溯）</Link>
            </Typography.Text>
          )}

          {/* 允许动作:门禁 allowed+reason 如实展示;确认在原导入入口完成,此处只读说明 */}
          <Descriptions bordered size="small" column={1} title="允许动作">
            <Descriptions.Item label={<Space>确认导入 <GateTag gate={detail.actions.confirm} /></Space>}>
              {detail.actions.confirm.allowed
                ? '可确认。确认需在原导入入口(预算/实际录入页或财务转换)完成,以保持编辑锁定一致。'
                : (detail.actions.confirm.reason ?? '当前状态不能确认')}
            </Descriptions.Item>
            <Descriptions.Item label={<Space>取消预览 <GateTag gate={detail.actions.cancel} /></Space>}>
              {detail.actions.cancel.allowed
                ? '取消后这份预览即失效,不会写入任何数据;如需导入需重新上传并生成新预览。'
                : (detail.actions.cancel.reason ?? '当前状态不能取消')}
            </Descriptions.Item>
            <Descriptions.Item label={<Space>撤销已导入 <GateTag gate={detail.actions.rollback} /></Space>}>
              {detail.actions.rollback.allowed
                ? (detail.actions.rollback.reason ?? '仅当导入后相关数据未再改动时可撤销成功')
                : (
                  <>
                    {detail.actions.rollback.reason ?? '当前状态不能撤销'}
                    <br />
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{rollbackCorrectionAdvice(detail)}</Typography.Text>
                  </>
                )}
            </Descriptions.Item>
          </Descriptions>
          <Space wrap>
            {pending && detail.actions.cancel.allowed && (
              <Popconfirm
                title={`取消待确认批次 #${detail.id} 的预览?`}
                description="取消后这份预览即失效;如需导入,需要重新上传并生成新预览。"
                okText="取消预览"
                okButtonProps={{ danger: true }}
                onConfirm={() => cancelMutation.mutate(detail.id)}
              >
                <Button danger loading={cancelMutation.isPending}>取消预览</Button>
              </Popconfirm>
            )}
            {committed && detail.actions.rollback.allowed && (
              <Popconfirm
                title={`撤销批次 #${detail.id} 的已导入数据?`}
                description={detail.actions.rollback.reason ?? '仅当导入后相关数据未再改动时才会撤销成功;已有后续修改时将被拒绝并给出原因。'}
                okText="撤销已导入"
                okButtonProps={{ danger: true }}
                onConfirm={() => rollbackMutation.mutate(detail.id)}
              >
                <Button danger loading={rollbackMutation.isPending}>撤销已导入</Button>
              </Popconfirm>
            )}
          </Space>

          {/* 冻结明细(frozen-detail)只读查看;旧批次的能力说明由 ImportSummaryView 的 legacy 提示承担 */}
          {detail.detailCapability === 'frozen-detail' && (
            <>
              <Typography.Title level={5} style={{ marginBottom: 0 }}>冻结差异明细(只读)</Typography.Title>
              <FrozenRows batchId={detail.id} detail={detail} />
            </>
          )}
        </Space>
      )}
    </Drawer>
  );
}
