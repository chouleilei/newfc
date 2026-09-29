/**
 * 统一导入预览、确认与结果面板(方案《易用性与直觉化交互实施方案》§4.4/§5.3,任务 UX-15)。
 *
 * 三条导入路径(标准模板/清洗/财务转换)共用同一份核对信息:
 * - 摘要:写入目标(年度/版本)、期间/截止日(多年度按组展示真实写入范围)、组织范围、
 *   金额单位、负数含义、动作统计(新增/覆盖/清零/不变/备注变更/跳过)、是否更新当前累计、
 *   是否生成快照、差异比较基线与结果位置;
 * - 明细:服务端创建预览时冻结的逐行差异,经 preview-rows 分页接口读取(不是 20 行示例),
 *   支持按组织/动作/警告筛选,源工作表+行号定位;金额概览为万元,悬停查看精确到分的元值
 *   (利润方向口径),差异判断由服务端整数分完成,不用舍入显示值;
 * - 确认只发送批次 ID;已取消/失效批次由批次详情 actions.confirm.allowed+reason 禁用并展示原因;
 * - 结果未知恢复:确认超时/网络错误时先查批次状态——已 committed 进入成功结果展示,
 *   仍 pending 允许重试同一批次确认,绝不自动新建另一个导入批次;
 * - 旧批次(legacy-summary)显示已有摘要并标注能力范围。
 *
 * ImportSummaryView / ImportPreviewRowsTable / confirmBlockReason 为纯展示/纯函数,
 * 与状态ful 的 ImportPreviewModal 分离,便于静态渲染与行为测试。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, App, Button, Checkbox, Descriptions, Modal, Select, Space, Spin, Statistic, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ApiError, api, errorText } from '../api/client';
import {
  cancelImportBatch,
  confirmImportBatchWithRecovery,
  getImportBatchDetail,
  listImportBatchPreviewRows,
  COMPARISON_BASIS_LABEL,
  IMPORT_BATCH_STATUS_LABEL,
  IMPORT_SOURCE_LABEL,
  PREVIEW_ACTION_COLOR,
  PREVIEW_ACTION_LABEL,
  RESULT_LOCATION_LABEL,
  type ImportBatchDetail,
  type ImportPreviewRow,
  type PreviewAction,
} from '../api/importBatch';
import { formatQuantity } from '../utils/money';
import { buildScopeSearch } from '../utils/workspaceScope';
import MoneyText from './MoneyText';

const ROWS_PAGE_SIZE = 50;

/* ============================== 纯函数与纯展示部件 ============================== */

/**
 * 确认按钮的禁用原因(纯函数):
 * 批次非待确认(已提交/已取消/已撤销/已失效)或服务端门禁不允许时给出原因;否则为 null。
 * extraReason 为路径自带的额外门禁(如实际页确认前又出现了未保存输入)。
 */
export function confirmBlockReason(detail: ImportBatchDetail | null, extraReason?: string | null): string | null {
  if (extraReason) return extraReason;
  if (!detail) return '批次详情加载中';
  if (!detail.actions.confirm.allowed) return detail.actions.confirm.reason ?? `批次已${IMPORT_BATCH_STATUS_LABEL[detail.status]}，不能确认`;
  return null;
}

/** 成功结果的位置入口(结果落点由统一摘要的 resultLocation 决定,预算/实际/历史各异)。 */
export function importResultLinks(detail: ImportBatchDetail): { label: string; to: string }[] {
  const links: { label: string; to: string }[] = [];
  if (detail.kind === 'budget') {
    if (detail.target.versionId != null) {
      links.push({
        label: `查看预算版本（${detail.target.year ?? ''} 年 · ${detail.target.versionName ?? `#${detail.target.versionId}`}）`,
        to: `/budget/${detail.target.versionId}`,
      });
    }
  } else {
    const result = detail.result as { results?: { year: number; snapshotDate: string; count: number; batchId: number }[] } | null;
    const groups = Array.isArray(result?.results) ? result!.results! : [];
    const years = [...new Set(groups.map((group) => group.year))];
    for (const year of years) {
      links.push({ label: `查看 ${year} 年实际数`, to: `/actual?year=${year}` });
    }
    for (const group of groups) {
      links.push({
        label: `在 ${group.year} 年年度执行分析中查看（快照 #${group.batchId}）`,
        to: `/analysis?${buildScopeSearch('analysis', { year: group.year, actualSnapshotId: group.batchId })}`,
      });
    }
  }
  links.push({ label: '导入批次记录', to: '/data?tab=imports' });
  return links;
}

/** 明细值单元格:金额=万元概览 + 精确元 title;数量=自然单位;备注=文本。差异不由显示值判断。 */
function PreviewValue({ row, side }: { row: ImportPreviewRow; side: 'old' | 'new' }) {
  if (row.valueKind === 'amount') {
    const cents = side === 'old' ? row.oldCents : row.newCents;
    const exact = side === 'old' ? row.oldValue : row.newValue;
    if (cents == null) return <Typography.Text type="secondary">—</Typography.Text>;
    return <MoneyText cents={cents} size="sm" title={`精确值 ${exact ?? ''} 元（利润方向）`} />;
  }
  if (row.valueKind === 'quantity') {
    const scaled = side === 'old' ? row.oldQuantity : row.newQuantity;
    if (scaled == null) return <Typography.Text type="secondary">—</Typography.Text>;
    return <span title={`数量精确值 ${side === 'old' ? row.oldValue : row.newValue}（自然单位）`}>{formatQuantity(scaled)}</span>;
  }
  const text = side === 'old' ? row.oldText : row.newText;
  return text ? <Typography.Text style={{ fontSize: 12 }}>{text}</Typography.Text> : <Typography.Text type="secondary">—</Typography.Text>;
}

/** 统一摘要(三种导入方式共用同一组核对问题)。 */
export function ImportSummaryView({ detail }: { detail: ImportBatchDetail }) {
  const preview = detail.preview;
  const targetLabel = detail.kind === 'budget'
    ? `${detail.target.year ?? ''} 年 · ${detail.target.versionName ?? `版本 #${detail.target.versionId ?? '?'}`}（预算草稿）`
    : detail.history
      ? '补录历史快照（不更新当前累计）'
      : '更新当前实际';
  const periods = preview?.periods?.length ? preview.periods : detail.target.periods ?? [];
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Descriptions bordered size="small" column={2}>
        <Descriptions.Item label="批次">#{detail.id} · {IMPORT_SOURCE_LABEL[preview?.source ?? 'standard']}</Descriptions.Item>
        <Descriptions.Item label="状态">
          <Tag color={detail.status === 'pending' ? 'gold' : detail.status === 'committed' ? 'green' : 'default'}>
            {IMPORT_BATCH_STATUS_LABEL[detail.status]}
          </Tag>
        </Descriptions.Item>
        <Descriptions.Item label="写入目标" span={2}>{targetLabel}</Descriptions.Item>
        {periods.length > 0 && (
          <Descriptions.Item label="期间 / 截止日（真实写入范围）" span={2}>
            <Space direction="vertical" size={2}>
              {periods.map((period) => (
                <span key={`${period.year}:${period.snapshotDate}`}>
                  • {period.year} 年（截止 {period.snapshotDate}）：<b>{period.entryCount}</b> 条
                </span>
              ))}
              {detail.kind === 'actual' && !detail.history && periods.length > 1 && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  各期间的逐行「变化」均相对导入前的当前累计计算；确认时各期间依次整包写入，同一年度的当前累计以最后写入的期间为准。
                </Typography.Text>
              )}
            </Space>
          </Descriptions.Item>
        )}
        <Descriptions.Item label="涉及组织">
          {preview ? <span title={preview.orgScope.codes.join('、')}>{preview.orgScope.count} 个组织</span> : '—'}
        </Descriptions.Item>
        <Descriptions.Item label="金额单位">元（服务端整数分冻结）；界面概览按万元显示，明细可核对精确元值</Descriptions.Item>
        <Descriptions.Item label="负数含义" span={2}>利润方向口径：收入为正、成本费用为负（界面录入为正数，负数表示冲回）；数量按科目计量单位</Descriptions.Item>
        {preview && (
          <>
            <Descriptions.Item label="更新当前累计">{preview.updatesCurrent ? '是' : '否'}</Descriptions.Item>
            <Descriptions.Item label="生成快照">{preview.createsSnapshot ? '是' : '否'}</Descriptions.Item>
            <Descriptions.Item label="差异比较基线">{COMPARISON_BASIS_LABEL[preview.comparisonBasis]}</Descriptions.Item>
            <Descriptions.Item label="结果位置">{RESULT_LOCATION_LABEL[preview.resultLocation]}</Descriptions.Item>
          </>
        )}
        <Descriptions.Item label="文件指纹" span={2}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{detail.originalName} · {detail.sha256.slice(0, 16)}…</Typography.Text>
        </Descriptions.Item>
      </Descriptions>
      {preview && (
        <Space wrap size="middle">
          <Statistic title="新增" value={preview.actions.insert} />
          <Statistic title="覆盖" value={preview.actions.overwrite} />
          <Statistic title="清零" value={preview.actions.clear} />
          <Statistic title="不变" value={preview.actions.unchanged} />
          <Statistic title="备注变更" value={preview.actions.noteChange} />
          {preview.actions.skipped > 0 && <Statistic title="跳过" value={preview.actions.skipped} />}
          {preview.actions.excluded > 0 && <Statistic title="排除" value={preview.actions.excluded} />}
          {preview.warnings > 0 && <Statistic title="警告行" value={preview.warnings} valueStyle={{ color: 'var(--bd-warning, #b25e09)' }} />}
        </Space>
      )}
      {detail.detailCapability === 'legacy-summary' && (
        <Alert type="info" showIcon message="仅提供摘要" description={detail.detailNote ?? '该批次创建于明细能力启用前，仅提供摘要。'} />
      )}
      {!preview && (
        <Alert type="info" showIcon message="该批次没有统一预览摘要（创建于统一预览能力启用前）；以上信息与导入批次记录一致。" />
      )}
    </Space>
  );
}

export interface ImportPreviewRowsTableProps {
  rows: ImportPreviewRow[];
  total: number;
  page: number;
  loading?: boolean;
  actionFilter?: PreviewAction;
  orgFilter?: number;
  warningOnly: boolean;
  /** 组织筛选项(由统一摘要 orgScope 映射组织树得到) */
  orgOptions: { value: number; label: string }[];
  onPageChange: (page: number) => void;
  onActionFilterChange: (action: PreviewAction | undefined) => void;
  onOrgFilterChange: (orgId: number | undefined) => void;
  onWarningOnlyChange: (checked: boolean) => void;
}

/** 冻结明细行表(分页/筛选由服务端 preview-rows 接口完成;非全量示例)。 */
export function ImportPreviewRowsTable(props: ImportPreviewRowsTableProps) {
  const columns: ColumnsType<ImportPreviewRow> = [
    {
      title: '源位置', width: 130,
      render: (_, row) => row.sourceRow != null
        ? <Typography.Text style={{ fontSize: 12 }}>{row.sourceSheet || '源文件'}!第 {row.sourceRow} 行</Typography.Text>
        : <Tag>无法定位源行</Tag>,
    },
    { title: '组织', width: 110, render: (_, row) => row.orgCode || '—' },
    { title: '科目', width: 130, render: (_, row) => row.accountCode || '—' },
    {
      title: '类型', width: 70,
      render: (_, row) => row.valueKind === 'amount' ? '金额' : row.valueKind === 'quantity' ? '数量' : '备注',
    },
    { title: '原值（万元）', align: 'right', width: 130, render: (_, row) => <PreviewValue row={row} side="old" /> },
    { title: '新值（万元）', align: 'right', width: 130, render: (_, row) => <PreviewValue row={row} side="new" /> },
    {
      title: '动作', width: 90,
      render: (_, row) => <Tag color={PREVIEW_ACTION_COLOR[row.action]}>{PREVIEW_ACTION_LABEL[row.action]}</Tag>,
    },
    { title: '警告', render: (_, row) => row.warning ? <Typography.Text type="warning" style={{ fontSize: 12 }}>{row.warning}</Typography.Text> : null },
  ];
  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        明细为创建预览时冻结的逐行差异，经服务端分页读取（不是部分示例）；金额概览为万元，悬停数值可查看精确到分的元值（利润方向）。差异由整数分判定，与显示舍入无关。
      </Typography.Text>
      <Space wrap>
        <Select
          allowClear showSearch placeholder="按组织筛选" style={{ width: 200 }}
          value={props.orgFilter} options={props.orgOptions}
          onChange={(value) => props.onOrgFilterChange(value)}
        />
        <Select
          allowClear placeholder="按动作筛选" style={{ width: 160 }}
          value={props.actionFilter}
          options={Object.entries(PREVIEW_ACTION_LABEL).map(([value, label]) => ({ value: value as PreviewAction, label }))}
          onChange={(value) => props.onActionFilterChange(value)}
        />
        <Checkbox checked={props.warningOnly} onChange={(event) => props.onWarningOnlyChange(event.target.checked)}>仅看警告行</Checkbox>
      </Space>
      <Table
        rowKey="id" size="small" loading={props.loading}
        dataSource={props.rows} columns={columns} scroll={{ x: 980, y: 380 }}
        pagination={{
          current: props.page,
          pageSize: ROWS_PAGE_SIZE,
          total: props.total,
          showSizeChanger: false,
          showTotal: (total) => `共 ${total} 条（分页读取）`,
          onChange: props.onPageChange,
        }}
      />
    </Space>
  );
}

/* ============================== 状态ful 面板(弹窗) ============================== */

export interface ImportPreviewModalProps {
  open: boolean;
  batchId: number | null;
  title?: string;
  /** 确认按钮文案(默认「确认写入」) */
  confirmLabel?: string;
  /** 额外禁用原因(展示并禁用确认;静态原因,如版本已锁定) */
  confirmDisabledReason?: string | null;
  /** 确认前动态门禁:返回原因则阻止本次确认(如上传后表格又出现了未保存输入) */
  beforeConfirm?: () => string | null;
  /** 覆盖确认等额外内容(渲染在确认按钮之前;清洗路径的覆盖勾选) */
  confirmExtra?: React.ReactNode;
  /** 路径自带补充内容(如财务的按组织×根科目变化表) */
  extraContent?: React.ReactNode;
  /** 提交成功后调用(刷新页面数据等);内部已捕获异常,失败仅提示不影响成功状态 */
  onConfirmed?: (info: { batchId: number; viaRecovery: boolean }) => void | Promise<void>;
  /** 预览取消成功后调用(解除编辑锁等) */
  onCancelled?: () => void;
  /** 取消请求失败(服务端残留待确认批次);缺省给持续警告与处理入口 */
  onCancelFailed?: (batchId: number) => void;
  onClose: () => void;
}

type PanelPhase = 'view' | 'done' | 'cancelled';

interface ConfirmIssue {
  kind: 'rejected' | 'still-pending' | 'unverifiable';
  message: string;
}

export default function ImportPreviewModal(props: ImportPreviewModalProps) {
  const { message, modal } = App.useApp();
  const [detail, setDetail] = useState<ImportBatchDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [phase, setPhase] = useState<PanelPhase>('view');
  const [viaRecovery, setViaRecovery] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [issue, setIssue] = useState<ConfirmIssue | null>(null);
  const [rows, setRows] = useState<ImportPreviewRow[]>([]);
  const [rowsTotal, setRowsTotal] = useState(0);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [actionFilter, setActionFilter] = useState<PreviewAction | undefined>();
  const [orgFilter, setOrgFilter] = useState<number | undefined>();
  const [warningOnly, setWarningOnly] = useState(false);
  const [orgOptions, setOrgOptions] = useState<{ value: number; label: string }[]>([]);
  const confirmInFlightRef = useRef(false);

  const batchId = props.batchId;

  /** 重取批次详情(状态/结果/门禁的真值来源);失败不覆盖已有内容 */
  const refetchDetail = useCallback(async (): Promise<ImportBatchDetail | null> => {
    if (batchId == null) return null;
    try {
      const next = await getImportBatchDetail(batchId);
      setDetail(next);
      return next;
    } catch {
      return null;
    }
  }, [batchId]);

  useEffect(() => {
    if (!props.open || batchId == null) return;
    let cancelled = false;
    setDetail(null); setLoadError(null); setPhase('view'); setViaRecovery(false); setIssue(null);
    setPage(1); setActionFilter(undefined); setOrgFilter(undefined); setWarningOnly(false);
    getImportBatchDetail(batchId)
      .then(async (loaded) => {
        if (cancelled) return;
        setDetail(loaded);
        // 组织筛选选项:统一摘要给编码,preview-rows 按 orgId 过滤,经组织树映射
        if (loaded.detailCapability === 'frozen-detail' && (loaded.preview?.orgScope.count ?? 0) > 0) {
          try {
            const tree = await api.get<{ rows: { id: number; code: string; name: string }[] }>('/org/tree');
            if (cancelled) return;
            const idByCode = new Map(tree.rows.map((row) => [row.code, row.id] as const));
            setOrgOptions((loaded.preview?.orgScope.codes ?? [])
              .filter((code) => idByCode.has(code))
              .map((code) => ({ value: idByCode.get(code)!, label: code })));
          } catch { /* 组织树不可用时仅不提供组织筛选下拉 */ }
        }
      })
      .catch((error) => { if (!cancelled) setLoadError(errorText(error)); });
    return () => { cancelled = true; };
  }, [props.open, batchId]);

  useEffect(() => {
    if (!props.open || batchId == null || detail?.detailCapability !== 'frozen-detail') return;
    let cancelled = false;
    setRowsLoading(true);
    listImportBatchPreviewRows(batchId, { page, pageSize: ROWS_PAGE_SIZE, orgId: orgFilter, action: actionFilter, warningOnly })
      .then((result) => { if (!cancelled) { setRows(result.items); setRowsTotal(result.total); } })
      .catch((error) => {
        if (cancelled) return;
        // 明细不可读(已取消清理/旧批次)时退回摘要视图,原因由 detailNote 展示
        if (error instanceof ApiError && error.status === 404) {
          setRows([]); setRowsTotal(0);
          setDetail((current) => current ? { ...current, detailCapability: 'legacy-summary', detailNote: error.body.message } : current);
        } else message.error(errorText(error));
      })
      .finally(() => { if (!cancelled) setRowsLoading(false); });
    return () => { cancelled = true; };
  }, [props.open, batchId, detail?.detailCapability, page, actionFilter, orgFilter, warningOnly, message]);

  const enterSuccess = useCallback(async (recovered: boolean) => {
    setPhase('done');
    setViaRecovery(recovered);
    setIssue(null);
    await refetchDetail(); // 拿提交后的结果与结果位置
    if (batchId != null && props.onConfirmed) {
      try {
        await props.onConfirmed({ batchId, viaRecovery: recovered });
      } catch (error) {
        // 批次已提交,仅调用方刷新失败:不按导入失败处理
        message.warning(`批次 #${batchId} 已提交成功，但页面数据刷新失败（${errorText(error)}），请手动刷新页面`);
      }
    }
  }, [batchId, props, refetchDetail, message]);

  const doConfirm = async () => {
    if (batchId == null || confirmInFlightRef.current) return;
    const blocked = props.beforeConfirm?.();
    if (blocked) { message.warning(blocked); return; }
    confirmInFlightRef.current = true;
    setConfirming(true);
    setIssue(null);
    try {
      const outcome = await confirmImportBatchWithRecovery(batchId);
      switch (outcome.kind) {
        case 'committed':
          await enterSuccess(outcome.viaRecovery);
          return;
        case 'rejected':
          // 服务端在确认失败时会自动取消该 pending 批次:刷新详情让状态与门禁落到真值
          setIssue({ kind: 'rejected', message: outcome.message });
          await refetchDetail();
          return;
        case 'still-pending':
          setIssue({ kind: 'still-pending', message: '确认请求未收到响应；已核对批次仍为待确认，可直接重试确认（同一批次，不会重复导入，也不会新建批次）。' });
          return;
        case 'unverifiable':
          setIssue({ kind: 'unverifiable', message: `确认结果未知：${outcome.reason}。尚未确认是否已写入，请先「查询批次状态」核对；在核对前不要重新上传，以免重复导入。` });
          return;
      }
    } finally {
      confirmInFlightRef.current = false;
      setConfirming(false);
    }
  };

  /** 结果待核对时的手动核对:已提交则进入成功结果,仍待确认则可重试 */
  const recheckStatus = async () => {
    if (batchId == null) return;
    setConfirming(true);
    try {
      const next = await refetchDetail();
      if (!next) { setIssue({ kind: 'unverifiable', message: '批次状态查询仍失败，请稍后重试。' }); return; }
      if (next.status === 'committed') { await enterSuccess(true); return; }
      if (next.status === 'pending') { setIssue({ kind: 'still-pending', message: '已核对：批次仍为待确认，可直接重试确认。' }); return; }
      setIssue({ kind: 'rejected', message: `批次已${IMPORT_BATCH_STATUS_LABEL[next.status]}（${next.actions.confirm.reason ?? ''}），本次确认未生效。` });
    } finally {
      setConfirming(false);
    }
  };

  const doCancel = () => {
    if (batchId == null) return;
    modal.confirm({
      title: `取消待确认批次 #${batchId}？`,
      content: '取消后这份预览即失效；如需导入，需要重新上传并生成新预览。',
      okText: '取消预览', okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await cancelImportBatch(batchId);
          setPhase('cancelled');
          setIssue(null);
          await refetchDetail();
          props.onCancelled?.();
        } catch (error) {
          if (props.onCancelFailed) props.onCancelFailed(batchId);
          else {
            message.warning({
              duration: 0,
              content: <span>预览批次 #{batchId} 取消失败（{errorText(error)}），请到 <Link to="/data?tab=imports">实际 → 导入批次</Link> 处理</span>,
            });
          }
        }
      },
    });
  };

  /** 右上角关闭:待确认视同取消预览;已终结(成功/取消)直接关闭 */
  const requestClose = () => {
    if (phase === 'view' && detail?.status === 'pending') { doCancel(); return; }
    /* 确认被服务端拒绝后批次已被自动取消(终态、不可再确认):关闭时按「取消」口径通知调用方
       解除编辑锁定,否则预算/实际编辑目标会一直停在「导入进行中」锁定态,只能刷新页面恢复 */
    if (phase === 'view' && detail != null && detail.status !== 'committed') props.onCancelled?.();
    props.onClose();
  };

  const blockReason = confirmBlockReason(detail, props.confirmDisabledReason);
  const pending = detail?.status === 'pending' && phase === 'view';
  const footer = phase === 'view' ? (
    <Space style={{ width: '100%', justifyContent: 'space-between' }}>
      <Button danger disabled={!pending || confirming} onClick={doCancel}>取消预览</Button>
      <Space>
        {issue && (issue.kind === 'still-pending' || issue.kind === 'unverifiable') && (
          <Button loading={confirming} onClick={() => void recheckStatus()}>查询批次状态</Button>
        )}
        <Tooltip title={blockReason ?? undefined}>
          <span>
            <Button type="primary" loading={confirming} disabled={!pending || blockReason != null} onClick={() => void doConfirm()}>
              {props.confirmLabel ?? '确认写入'}
            </Button>
          </span>
        </Tooltip>
      </Space>
    </Space>
  ) : <Button type="primary" onClick={props.onClose}>关闭</Button>;

  return (
    <Modal
      open={props.open}
      title={props.title ?? `导入预览 · 批次 #${batchId ?? ''}`}
      width="min(1180px, 96vw)"
      maskClosable={false}
      destroyOnClose
      onCancel={requestClose}
      footer={footer}
    >
      <div style={{ maxHeight: '72vh', overflow: 'auto', padding: '0 2px' }}>
        {loadError && <Alert type="error" showIcon message="批次详情加载失败" description={loadError} />}
        {!detail && !loadError && <Spin style={{ display: 'block', margin: '48px auto' }} />}
        {detail && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {phase === 'done' && (
              <Alert
                type="success" showIcon
                message={`批次 #${detail.id} 已提交成功`}
                description={
                  <>
                    {viaRecovery ? '确认响应曾丢失，已经批次状态核对确认提交成功，未重复导入。' : null}
                    结果位置：
                    {importResultLinks(detail).map((link, index) => (
                      <Link key={link.to + index} to={link.to} style={{ marginRight: 12 }}>{link.label}</Link>
                    ))}
                  </>
                }
              />
            )}
            {phase === 'cancelled' && (
              <Alert type="info" showIcon message={`预览批次 #${detail.id} 已取消，未写入任何数据`} />
            )}
            {issue && (
              <Alert
                type={issue.kind === 'rejected' ? 'error' : 'warning'}
                showIcon
                message={issue.kind === 'rejected' ? '确认失败' : issue.kind === 'still-pending' ? '确认结果未返回，批次仍待确认' : '确认结果未知，待核对'}
                description={issue.message}
              />
            )}
            <ImportSummaryView detail={detail} />
            {props.extraContent}
            {detail.detailCapability === 'frozen-detail' && (
              <ImportPreviewRowsTable
                rows={rows}
                total={rowsTotal}
                page={page}
                loading={rowsLoading}
                actionFilter={actionFilter}
                orgFilter={orgFilter}
                warningOnly={warningOnly}
                orgOptions={orgOptions}
                onPageChange={setPage}
                onActionFilterChange={(value) => { setActionFilter(value); setPage(1); }}
                onOrgFilterChange={(value) => { setOrgFilter(value); setPage(1); }}
                onWarningOnlyChange={(checked) => { setWarningOnly(checked); setPage(1); }}
              />
            )}
            {props.confirmExtra && pending && props.confirmExtra}
            {pending && blockReason && <Alert type="warning" showIcon message={blockReason} />}
            {pending && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                确认只提交批次 #{detail.id}（服务端使用创建预览时冻结的内容）；预览期间编辑目标保持锁定，确认或取消后恢复。
              </Typography.Text>
            )}
          </Space>
        )}
      </div>
    </Modal>
  );
}
