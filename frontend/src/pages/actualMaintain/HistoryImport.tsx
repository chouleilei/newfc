import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Space, Button, App, Upload, DatePicker } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { api } from '../../api/client';
import ImportPreviewModal from '../../components/ImportPreviewPanel';

/** 历史快照补录:预览解析→统一预览面板核对→确认追加历史快照批次(不更新当前实际);
 *  截止日期必须显式选择(UX-08:不能把默认日期自动当成本次业务期间);
 *  确认只发批次 ID,结果未知先查批次状态(UX-15),绝不自动新建导入批次。 */
export function HistoryImport({ year, onDone }: { year: number; onDone: () => void }) {
  const { message, modal } = App.useApp();
  const [date, setDate] = useState<Dayjs | null>(null);
  const [importBatchId, setImportBatchId] = useState<number | null>(null);

  return (
    <Space wrap direction="vertical" style={{ width: '100%' }}>
      <Space wrap>
        <DatePicker placeholder="历史截止日期" value={date} onChange={setDate} disabled={importBatchId != null} disabledDate={(d) => d.year() !== year} />
        <Upload
          showUploadList={false} accept=".xlsx"
          beforeUpload={async (f) => {
            if (!date || date.year() !== year) {
              message.warning(`请先选择 ${year} 年内的历史截止日期`);
              return false;
            }
            const fd = new FormData(); fd.append('file', f); fd.append('confirm', 'false'); fd.append('history', 'true'); fd.append('snapshotDate', date.format('YYYY-MM-DD'));
            try {
              const preview = await api.post<{ year: number; snapshotDate: string; count: number; importBatchId: number }>('/io/actual/import', fd);
              setImportBatchId(preview.importBatchId);
              // 服务端以用户选择日期覆盖文件日期,回显最终进入预览批次的权威日期。
              setDate(dayjs(preview.snapshotDate));
              message.info(`文件解析成功:${preview.year} 年截止 ${preview.snapshotDate},共 ${preview.count} 条;请在预览中核对后确认`);
            } catch (e) {
              const err = e as { body?: { errors?: { row: number; field: string; message: string }[]; message: string } };
              modal.error({
                title: err.body?.message ?? '导入失败', width: 640,
                content: <div style={{ maxHeight: 300, overflow: 'auto' }}>{(err.body?.errors ?? []).map((x, i) => <div key={i}>第{x.row}行 [{x.field}]: {x.message}</div>)}</div>,
              });
            }
            return false;
          }}
        >
          <Button icon={<i className="ri-history-line" aria-hidden />}>选择补录文件(预览)</Button>
        </Upload>
      </Space>
      <ImportPreviewModal
        open={importBatchId != null}
        batchId={importBatchId}
        title="历史补录导入预览"
        confirmLabel="确认补录（不覆盖当前实际）"
        onConfirmed={() => {
          message.success('历史快照已补录(当前实际未变更)');
          setImportBatchId(null);
          setDate(null);
          onDone();
        }}
        onCancelled={() => { setImportBatchId(null); }}
        onCancelFailed={(batchId) => message.warning({
          duration: 0,
          content: <span>预览批次 #{batchId} 取消失败，请到 <Link to="/data?tab=imports">实际 → 导入批次</Link> 处理</span>,
        })}
        onClose={() => setImportBatchId(null)}
      />
    </Space>
  );
}
