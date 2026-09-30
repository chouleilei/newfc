import { Alert, Tag } from 'antd';
import type { RowErrorDto } from '../../api/projectContract';

/** T-4 项目与合同页面公用:批次状态、逐行错误、阶段/状态标签。 */

export const BATCH_STATUS: Record<'imported' | 'voided', React.ReactNode> = {
  imported: <Tag color="success">已导入</Tag>,
  voided: <Tag>已作废</Tag>,
};

/** 逐行错误(导入全量校验失败时不写库)。 */
export function RowErrors({ errors, title, max = 50 }: { errors: RowErrorDto[]; title: string; max?: number }) {
  if (!errors.length) return null;
  return (
    <Alert type="error" showIcon message={`${title}(${errors.length} 处)`}
      description={(
        <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 220, overflow: 'auto' }}>
          {errors.slice(0, max).map((e, i) => <li key={i}>{e.row ? `第 ${e.row} 行` : '文件'}{e.field ? `[${e.field}]` : ''}:{e.message}</li>)}
          {errors.length > max && <li>……另有 {errors.length - max} 处</li>}
        </ul>
      )} />
  );
}

export const CONTRACT_STAGE_LABELS: Record<string, string> = {
  initiation: '需求立项', procurement: '招采准备', drafting: '合同起草', approval: '审批签署', performance: '履约执行', settlement: '变更结算', archived: '归档关闭',
};
export const CONTRACT_STAGE_ORDER = ['initiation', 'procurement', 'drafting', 'approval', 'performance', 'settlement', 'archived'] as const;
export const CONTRACT_STATUS = {
  active: { text: '进行中', color: 'processing' }, closed: { text: '已关闭', color: 'success' },
  terminated: { text: '已终止', color: 'warning' }, voided: { text: '已作废', color: 'default' },
};
export const CONTRACT_DOC_TYPE_LABELS: Record<string, string> = {
  procurement: '招采文件', contract_text: '合同正文', signed: '签署件', performance: '履约记录', acceptance: '验收文件', invoice: '发票',
  change: '变更依据', settlement: '结算文件', other: '其他',
};
export const FLOW_STATUS = {
  submitted: { text: '待复核', color: 'warning' }, approved: { text: '已批准', color: 'success' },
  rejected: { text: '已驳回', color: 'error' }, paid: { text: '已支付', color: 'blue' },
};
