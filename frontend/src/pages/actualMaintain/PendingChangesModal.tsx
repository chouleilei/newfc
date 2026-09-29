import { Modal, Table, Tag, Typography } from 'antd';
import type { DraftDirtyItem } from './useActualDraft';

const KIND_LABEL: Record<DraftDirtyItem['kind'], string> = {
  value: '数值',
  note: '明细备注',
  summaryMemo: '汇总备注',
};

export interface PendingChangeRow extends DraftDirtyItem {
  orgName: string;
  accountLabel: string;
}

/**
 * 全部待保存项一览(UX-09):不论是否在当前视图,逐条列出组织 × 科目、类型与原值 → 新值,
 * 并标明该项当前是否可见(不可见的修改在保存时同样会随整包提交)。
 */
export function PendingChangesModal(props: {
  open: boolean;
  onClose: () => void;
  items: PendingChangeRow[];
  unitHint?: string;
}) {
  return (
    <Modal
      title={`全部待保存修改（共 ${props.items.length} 项）`}
      open={props.open}
      onCancel={props.onClose}
      footer={null}
      width={720}
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        以下为本次保存将一并提交的全部修改，包含当前视图看不到的组织与科目；保存按整年度整包提交，未修改的格不受影响。
      </Typography.Paragraph>
      <Table
        size="small"
        rowKey={(r) => `${r.kind}:${r.key}`}
        dataSource={props.items}
        pagination={props.items.length > 12 ? { pageSize: 12, size: 'small' } : false}
        columns={[
          { title: '组织', dataIndex: 'orgName', width: 140, render: (v: string) => v || '—' },
          { title: '科目', dataIndex: 'accountLabel', width: 200, render: (v: string) => v || '—' },
          { title: '类型', dataIndex: 'kind', width: 90, render: (k: DraftDirtyItem['kind']) => <Tag>{KIND_LABEL[k]}</Tag> },
          {
            title: '原值 → 新值', key: 'change',
            render: (_, r) => (
              <span style={{ fontSize: 12 }}>
                <Typography.Text type="secondary" delete={r.before !== ''}>{r.before === '' ? '（空）' : r.before}</Typography.Text>
                {' → '}
                <Typography.Text strong>{r.after === '' ? '（清空）' : r.after}</Typography.Text>
              </span>
            ),
          },
          {
            title: '当前视图', dataIndex: 'visible', width: 90,
            render: (v: boolean) => (v ? <Tag color="green">可见</Tag> : <Tag color="orange">不在视图</Tag>),
          },
        ]}
      />
      {props.unitHint && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{props.unitHint}</Typography.Text>
      )}
    </Modal>
  );
}
