import { useRef, useState } from 'react';
import { Space, Button, App, Dropdown, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import { api, download } from '../../api/client';
import type { MatrixResponse } from './types';
import CleaningImportWizard from '../../components/CleaningImportWizard';
import ImportEntryModal, { type ImportEntryKind } from '../../components/ImportEntryModal';
import ImportPreviewModal from '../../components/ImportPreviewPanel';

/**
 * 编制页头部:主操作 = 保存草稿(Ctrl+S,立即可用,平时自动保存) + 记录本轮修改(可选说明) + 定稿;
 * 「导入 Excel」为页头可见次级入口(UX-13),打开导入方式选择;导出/测算/体检/台账等收入「更多」。
 * 导入互斥(UX-13):创建预览前先由 onPrepareImport 排空自动保存队列、保存最新草稿并锁定编辑目标;
 * 确认成功由 onImport 内部解锁,取消/失败经 onReleaseImportLock 解锁并恢复编辑。
 * 统一预览(UX-15):标准导入预览升级为 ImportPreviewModal(冻结差异/确认只发批次 ID/结果未知恢复);
 * 确认(含恢复)在面板内完成后,onImport 只负责采用服务端真值并解锁。
 */
export function BudgetHeaderActions(props: {
  versionId: number;
  version: MatrixResponse['version'];
  editable: boolean;
  dirty: boolean;
  quality?: { blockingCount: number; warningCount: number; coverage: { filled: number; total: number; percent: number } };
  totalNotesCount: number;
  autoSavePending: boolean;
  draftActionPending: boolean;
  checkpointPending: boolean;
  checkpointCount: number;
  onRecord: () => void;
  onSaveNow: () => void;
  onOpenCompilation: () => void;
  onClear: () => void;
  onFinalize: () => void;
  onCalculate: () => void;
  onQuality: () => void;
  onOpenLedger: () => void;
  onImport: (importBatchId: number) => Promise<void>;
  /** 创建预览前排空自动保存并锁定编辑目标;false = 草稿保存失败(已提示),未锁定,不得继续导入 */
  onPrepareImport: () => Promise<boolean>;
  /** 取消/失败时解除导入编辑锁(确认成功由 onImport 解锁) */
  onReleaseImportLock: () => void;
}) {
  const { modal } = App.useApp();
  const { versionId, version: v, editable, dirty, quality, totalNotesCount } = props;
  const fileRef = useRef<HTMLInputElement>(null);
  const [entryOpen, setEntryOpen] = useState(false);
  const [cleaningOpen, setCleaningOpen] = useState(false);
  /** UX-15:待确认的标准导入预览批次(面板内完成核对/确认/取消/结果恢复) */
  const [previewBatchId, setPreviewBatchId] = useState<number | null>(null);

  const importExcel = async (file: File) => {
    // UX-13 互斥:先保存最新草稿并锁定编辑目标,再创建预览;
    // 不能到确认时才保存——那会让自己的保存使刚生成的预览基线失效
    if (!(await props.onPrepareImport())) return;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('versionId', String(versionId));
    fd.append('confirm', 'false');
    try {
      const preview = await api.post<{ preview: boolean; importBatchId: number; sha256: string; count: number }>('/io/budget/import', fd);
      // 统一预览面板负责核对/确认/取消与结果未知恢复;编辑锁由面板回调解除
      setPreviewBatchId(preview.importBatchId);
    } catch (e) {
      const err = e as { body?: { errors?: { row: number; field: string; message: string }[]; message: string } };
      modal.error({
        title: err.body?.message ?? '导入失败',
        width: 640,
        content: (
          <div>
            <div style={{ maxHeight: 300, overflow: 'auto' }}>
              {(err.body?.errors ?? []).map((x, i) => (
                <div key={i}>第{x.row}行 [{x.field}]: {x.message}</div>
              ))}
            </div>
            <div style={{ marginTop: 8, color: 'var(--newfc-text-secondary, rgba(0,0,0,0.65))' }}>请按以上行号修正文件后重新上传；格式特殊的文件可改用「导入 Excel → 非标准 Excel 清洗」手工匹配列。</div>
          </div>
        ),
      });
      props.onReleaseImportLock();
    }
  };

  const pickImportPath = (kind: ImportEntryKind) => {
    setEntryOpen(false);
    if (kind === 'standard') {
      fileRef.current?.click();
      return;
    }
    // 非标准清洗:打开向导前排空自动保存并锁定编辑,向导全程(含预览)保持锁定,关闭时解除
    void (async () => {
      if (await props.onPrepareImport()) setCleaningOpen(true);
    })();
  };

  const importDisabledReason = !editable
    ? '定稿或归档版本不可导入；请先在版本列表「基于此版继续编制」复制新草稿'
    : props.draftActionPending
      ? '正在保存或处理中，完成后即可导入'
      : undefined;
  const moreItems: MenuProps['items'] = [
    { key: 'tpl', icon: <i className="ri-download-2-line" aria-hidden />, label: '导入模板', onClick: () => download('/io/template/budget', '预算导入模板.xlsx') },
    { key: 'export', icon: <i className="ri-download-2-line" aria-hidden />, label: '导出明细', onClick: () => download(`/io/export/budget-detail/${versionId}`, `预算明细-${v.year}-${v.name}.xlsx`) },
    { type: 'divider' },
    { key: 'ledger', icon: <i className="ri-file-text-line" aria-hidden />, label: `测算依据台账${totalNotesCount > 0 ? ` (${totalNotesCount})` : ''}`, onClick: props.onOpenLedger },
    { key: 'history', icon: <i className="ri-history-line" aria-hidden />, label: `编制记录${props.checkpointCount > 0 ? ` (${props.checkpointCount})` : ''}`, onClick: props.onOpenCompilation },
    ...(editable ? [
      { type: 'divider' as const },
      { key: 'calc', icon: <i className="ri-calculator-line" aria-hidden />, label: '测算模板试算', disabled: props.draftActionPending, onClick: props.onCalculate },
      {
        key: 'quality',
        icon: (quality?.blockingCount ?? 0) > 0 ? <i className="ri-error-warning-line" aria-hidden /> : <i className="ri-checkbox-circle-line" aria-hidden />,
        label: `定稿体检${quality && quality.blockingCount + quality.warningCount > 0 ? `(${quality.blockingCount + quality.warningCount})` : ''}`,
        onClick: props.onQuality,
      },
      { key: 'clear', icon: <i className="ri-close-circle-line" aria-hidden />, danger: true, label: '清空数据', disabled: props.draftActionPending, onClick: () => modal.confirm({ title: '清空本版本全部预算数据?', okType: 'danger', onOk: props.onClear }) },
    ] : []),
  ];

  return (
    <>
    <Space size="middle" wrap>
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void importExcel(file);
        }}
      />
      <Tooltip title={importDisabledReason}>
        <span>
          <Button
            icon={<i className="ri-upload-2-line" aria-hidden />}
            disabled={!editable || props.draftActionPending}
            onClick={() => setEntryOpen(true)}
          >
            导入 Excel
          </Button>
        </span>
      </Tooltip>
      <Dropdown menu={{ items: moreItems }} trigger={['click']}>
        <Button icon={<i className="ri-more-2-fill" aria-hidden />}>更多</Button>
      </Dropdown>
      {editable && (
        <>
          <Tooltip title={!dirty ? '没有待保存的修改（平时约 1 秒自动保存）' : '立即保存最新修改；不会生成编制记录'}>
            <span>
              <Button
                icon={<i className="ri-save-3-line" aria-hidden />}
                disabled={!dirty || props.autoSavePending || props.draftActionPending}
                onClick={props.onSaveNow}
              >
                保存 (Ctrl+S)
              </Button>
            </span>
          </Tooltip>
          <Tooltip title={props.autoSavePending ? '自动保存进行中，完成后即可记录' : props.draftActionPending ? '正在处理中，完成后即可记录' : '为当前修改生成一条可查阅的编制记录，可选填写说明；数据本身已随保存落库'}>
            <span>
              <Button
                icon={<i className="ri-bookmark-line" aria-hidden />}
                loading={props.checkpointPending}
                disabled={props.autoSavePending || props.draftActionPending}
                onClick={props.onRecord}
              >
                记录本轮修改
              </Button>
            </span>
          </Tooltip>
          <Tooltip title={props.draftActionPending ? '正在保存或处理中，完成后即可定稿' : undefined}>
            <span>
              <Button
                type="primary"
                icon={<i className="ri-lock-2-line" aria-hidden />}
                loading={props.autoSavePending || props.draftActionPending}
                disabled={props.draftActionPending}
                onClick={props.onFinalize}
              >
                定稿版本
              </Button>
            </span>
          </Tooltip>
        </>
      )}
    </Space>
    <ImportEntryModal
      open={entryOpen}
      context="budget"
      targetLabel={`${v.year} 年 · ${v.name}`}
      onClose={() => setEntryOpen(false)}
      onPick={pickImportPath}
      onDownloadTemplate={() => download('/io/template/budget', '预算导入模板.xlsx')}
    />
    <CleaningImportWizard
      open={cleaningOpen}
      targetKind="budget"
      versionId={versionId}
      year={v.year}
      targetLabel={`${v.year} 年 · ${v.name}`}
      onClose={() => { setCleaningOpen(false); props.onReleaseImportLock(); }}
      onConfirmBatch={props.onImport}
    />
    <ImportPreviewModal
      open={previewBatchId != null}
      batchId={previewBatchId}
      title="标准模板导入预览"
      onConfirmed={async () => {
        // UX-15:确认(含结果未知恢复)已在面板内完成;onImport 只采用服务端真值并解锁
        if (previewBatchId != null) await props.onImport(previewBatchId);
      }}
      onCancelled={() => props.onReleaseImportLock()}
      onClose={() => setPreviewBatchId(null)}
    />
    </>
  );
}
