import { Modal, Typography, InputNumber } from 'antd';

/** 添加历史维护年份弹窗(输入状态由页面持有,校验与切换在页面回调) */
export function AddYearModal(props: {
  open: boolean;
  value: number;
  onValueChange: (v: number) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      title="添加历史维护年份"
      open={props.open}
      onCancel={props.onCancel}
      onOk={props.onConfirm}
      okText="添加并切换"
      cancelText="取消"
      width={380}
    >
      <div style={{ padding: '16px 0' }}>
        <Typography.Paragraph type="secondary">
          请输入要补录或维护的历史年份（如 2021、2020 年）：
        </Typography.Paragraph>
        <InputNumber
          style={{ width: '100%' }}
          min={1990}
          max={2100}
          value={props.value}
          onChange={(v) => props.onValueChange(v ?? 2020)}
          placeholder="例如 2020"
        />
      </div>
    </Modal>
  );
}
