import { Space, Modal, Input, Typography, theme } from 'antd';
import type { Row } from './types';

/** 单元格附注与公式编辑弹窗(受控:表单状态由页面持有,校验与写入走页面统一入口) */
export function NoteEditModal(props: {
  open: boolean;
  target: { orgId: number; row: Row } | null;
  orgName?: string;
  /** 汇总格模式(组织或科目至少一侧非叶子):只有附注,无行内公式,备注不参与数值汇总 */
  summary?: boolean;
  currentValue: string;
  formText: string;
  formFormula: string;
  onFormTextChange: (v: string) => void;
  onFormFormulaChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { token } = theme.useToken();
  const { target } = props;
  return (
    <Modal
      title={
        <Space>
          <i className="ri-file-text-line" style={{ color: token.colorPrimary }} aria-hidden />
          <span>
            {props.summary ? '汇总格备注' : '测算依据与公式'} · {target ? `${props.orgName} (${target.row.code} ${target.row.name})` : ''}
          </span>
        </Space>
      }
      open={props.open}
      onOk={props.onSave}
      onCancel={props.onCancel}
      okText={props.summary ? '保存备注' : '保存附注/公式'}
      cancelText="取消"
      width={560}
    >
      {target && (
        <div style={{ marginTop: 8 }}>
          <div style={{ marginBottom: 16 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              当前数值: <b>{props.currentValue || '0.00'}</b> {target.row.type === 'quantity' ? (target.row.unit ?? '') : '万元'}
              {props.summary && <span>（汇总值，随明细自动计算）</span>}
            </Typography.Text>
          </div>

          {!props.summary && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>
                <Space>
                  <i className="ri-calculator-line" aria-hidden />
                  <span>行内计算公式 (可选):</span>
                </Space>
              </div>
              <Input
                placeholder="例如: =35*1.2*12 或 =220+80+50 或 =300/(1+13%)"
                value={props.formFormula}
                onChange={(e) => props.onFormFormulaChange(e.target.value)}
                allowClear
              />
              <div style={{ fontSize: 12, color: 'var(--newfc-text-tertiary)', marginTop: 4 }}>
                支持四则运算、括号及税率百分比（以等号 = 开头），保存时将自动重新计算金额。
              </div>
            </div>
          )}

          <div style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              <Space>
                <i className="ri-edit-line" aria-hidden />
                <span>{props.summary ? '汇总格备注:' : '测算依据与业务说明 (附注):'}</span>
              </Space>
            </div>
            <Input.TextArea
              rows={4}
              placeholder={props.summary
                ? '记录该汇总口径的整体说明。备注仅作批注，不影响下属明细的数值汇总。'
                : '记录具体业务动因或项目明细。例如: 含 1# 机组 A 修转轮更换 220 万元，2# 变压器预防性试验 80 万元，常规备件 50 万元。'}
              value={props.formText}
              onChange={(e) => props.onFormTextChange(e.target.value)}
              maxLength={500}
              showCount
            />
            <div style={{ fontSize: 12, color: 'var(--newfc-text-tertiary)', marginTop: 4 }}>
              保存后可用 Ctrl+Z 撤销；「取消」只放弃本次弹窗中的输入，不影响已有内容。
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
