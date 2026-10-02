import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Space, Button, App, Dropdown, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import { api } from '../../api/client';
import CleaningImportWizard from '../../components/CleaningImportWizard';
import ImportEntryModal, { type ImportEntryKind } from '../../components/ImportEntryModal';
import ImportPreviewModal from '../../components/ImportPreviewPanel';

/**
 * 实际数页头部:主操作 = 保存并生成快照;「导入 Excel」为页头可见次级入口(UX-13),
 * 打开导入方式选择(当前任务含财务转换;历史补录仅标准模板导入);模板与导入批次收入「更多」。
 * 导入互斥(UX-13):进入导入前经 onRequestImport 守卫——有未保存输入时先保存或明确放弃;
 * 预览/清洗向导进行中由 importLocked 锁定编辑目标,确认/取消/失败后经 onImportLockChange 解除。
 * 统一预览(UX-15):标准导入预览升级为 ImportPreviewModal——多年度按组展示真实写入范围、
 * 冻结明细分页核对、确认只发批次 ID、结果未知先查批次状态再恢复,绝不自动新建导入批次。
 */
export function ActualHeaderActions(props: {
  editYear: number;
  frozen: boolean;
  historyMode: boolean;
  saving: boolean;
  canSave: boolean;
  /** 期间层面的保存阻断原因(未选截止日/早于当前累计截止日),禁用并作为按钮说明 */
  saveBlockReason?: string | null;
  hasUnsavedChanges: boolean;
  /** 导入进行中(预览待确认/清洗向导打开):锁定编辑目标,禁用再次进入导入 */
  importLocked: boolean;
  onOpenTemplate: () => void;
  onSave: () => void;
  onImported: () => void;
  /** 进入导入前的统一守卫:有未保存输入时先保存或明确放弃,然后才执行 proceed */
  onRequestImport: (proceed: () => void) => void;
  onImportLockChange: (locked: boolean) => void;
}) {
  const { message, modal } = App.useApp();
  const { editYear, historyMode } = props;
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const unsavedRef = useRef(props.hasUnsavedChanges);
  unsavedRef.current = props.hasUnsavedChanges;
  const [entryOpen, setEntryOpen] = useState(false);
  const [cleaningOpen, setCleaningOpen] = useState(false);
  /** UX-15:待确认的标准导入预览批次(面板内完成核对/确认/取消/结果恢复) */
  const [previewBatchId, setPreviewBatchId] = useState<number | null>(null);

  /* 取消失败会在服务端残留待确认批次:警告持续展示(不自动消失),并给直达链接 */
  const warnCancelFailed = (batchId: number, prefix = '') => {
    message.warning({
      duration: 0,
      content: <span>{prefix}预览批次 #{batchId} 取消失败，请到 <Link to="/data?tab=imports">实际 → 导入批次</Link> 处理</span>,
    });
  };

  const entryDisabledReason = props.frozen
    ? `${props.editYear} 年已关闭（冻结），不能导入；如需调整请先重新打开年度`
    : props.importLocked
      ? '导入进行中，请先完成或取消当前导入'
      : props.saving
        ? '正在提交保存，完成后即可导入'
        : undefined;
  const saveDisabledReason = props.frozen
    ? `${props.editYear} 年已关闭（冻结），不能保存实际数；如需调整请先重新打开年度`
    : props.saveBlockReason ?? (!props.canSave
      ? '当前没有待保存的修改'
      : undefined);

  const importExcel = async (file: File) => {
    if (unsavedRef.current) {
      // 防御:正常路径已被 onRequestImport 守卫拦住(保存或放弃后才放行)
      message.warning('当前表格有未保存修改，请先保存后再导入');
      return;
    }
    // 导入进行中锁定编辑目标,避免手工输入与导入写入并发覆盖
    props.onImportLockChange(true);
    const fd = new FormData(); fd.append('file', file); fd.append('confirm', 'false');
    if (historyMode) fd.append('history', 'true');
    try {
      const preview = await api.post<{ preview: boolean; importBatchId: number }>('/io/actual/import', fd);
      // 统一预览面板负责核对/确认/取消与结果未知恢复;编辑锁由面板回调解除
      setPreviewBatchId(preview.importBatchId);
    } catch (e) {
      const err = e as { body?: { errors?: { row: number; field: string; message: string }[]; message: string } };
      modal.error({
        title: err.body?.message ?? '导入失败', width: 640,
        content: (
          <div>
            <div style={{ maxHeight: 300, overflow: 'auto' }}>{(err.body?.errors ?? []).map((x, i) => <div key={i}>第{x.row}行 [{x.field}]: {x.message}</div>)}</div>
            <div style={{ marginTop: 8, color: 'var(--newfc-text-secondary, rgba(0,0,0,0.65))' }}>请按以上行号修正文件后重新上传；格式特殊的文件可改用「导入 Excel → 非标准 Excel 清洗」手工匹配列。</div>
          </div>
        ),
      });
      props.onImportLockChange(false);
    }
  };

  const pickImportPath = (kind: ImportEntryKind) => {
    setEntryOpen(false);
    if (kind === 'standard') props.onRequestImport(() => fileRef.current?.click());
    else if (kind === 'cleaning') props.onRequestImport(() => { props.onImportLockChange(true); setCleaningOpen(true); });
    else props.onRequestImport(() => navigate('/finance'));
  };

  const moreItems: MenuProps['items'] = [
    { key: 'tpl', icon: <i className="ri-download-2-line" aria-hidden />, label: '导入模板', onClick: props.onOpenTemplate },
    /* 导入批次原在侧栏占一行,已收进这里:它是本页导入动作的历史与撤销入口,
       与本页是同一工作流,放在侧栏反而要来回切。 */
    { key: 'batches', icon: <i className="ri-file-search-line" aria-hidden />, label: '导入批次', onClick: () => navigate('/data?tab=imports') },
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
      <Tooltip title={entryDisabledReason}>
        <span>
          <Button
            icon={<i className="ri-upload-2-line" aria-hidden />}
            disabled={props.frozen || props.importLocked || props.saving}
            onClick={() => setEntryOpen(true)}
          >
            导入 Excel
          </Button>
        </span>
      </Tooltip>
      <Dropdown menu={{ items: moreItems }} trigger={['click']}>
        <Button icon={<i className="ri-more-2-fill" aria-hidden />}>更多</Button>
      </Dropdown>
      <Tooltip title={saveDisabledReason}>
        <span>
          <Button
            type="primary"
            icon={<i className="ri-save-3-line" aria-hidden />}
            loading={props.saving}
            disabled={props.frozen || !props.canSave || props.saveBlockReason != null}
            onClick={() => props.onSave()}
          >
            {historyMode ? `补录 ${editYear} 年历史快照` : `保存 ${editYear} 年实际并生成快照`}
          </Button>
        </span>
      </Tooltip>
    </Space>
    <ImportEntryModal
      open={entryOpen}
      context={historyMode ? 'actual-history' : 'actual-current'}
      targetLabel={historyMode ? `${editYear} 年 · 补录历史快照` : `${editYear} 年 · 更新当前实际`}
      onClose={() => setEntryOpen(false)}
      onPick={pickImportPath}
      onDownloadTemplate={props.onOpenTemplate}
    />
    <CleaningImportWizard
      open={cleaningOpen}
      targetKind="actual-current"
      year={editYear}
      targetLabel={`${editYear} 年当前累计实际数`}
      confirmGuard={() => unsavedRef.current ? '当前表格有未保存修改，请先保存后再确认导入' : null}
      onClose={() => { setCleaningOpen(false); props.onImportLockChange(false); }}
      onConfirmBatch={async () => {
        // UX-15:确认(含结果未知恢复)已在向导内完成;这里只刷新数据并解锁
        props.onImported();
        props.onImportLockChange(false);
      }}
    />
    <ImportPreviewModal
      open={previewBatchId != null}
      batchId={previewBatchId}
      title={historyMode ? '历史补录导入预览' : '标准模板导入预览'}
      beforeConfirm={() => unsavedRef.current
        ? '上传后表格出现了未保存修改，不能确认导入；请取消本次预览，保存后重新导入'
        : null}
      onConfirmed={() => {
        props.onImported();
        props.onImportLockChange(false);
      }}
      onCancelled={() => props.onImportLockChange(false)}
      onCancelFailed={(batchId) => warnCancelFailed(batchId)}
      onClose={() => setPreviewBatchId(null)}
    />
    </>
  );
}
