import { Alert, Tag } from 'antd';
import type { RowErrorDto } from '../../api/riskInvestment';
import { formatMoney } from '../../utils/decimal';

/** T-5 投资与预测页面公用标签与展示(契约的中文标签是值,前端只能以类型导入契约,故在此维护一份)。 */

export const IC_VERSION_TYPE_LABEL: Record<string, string> = {
  estimate: '投资估算', design_estimate: '设计概算', adjusted_estimate: '调整概算',
  construction_budget: '施工图预算', settlement: '竣工结算', final_account: '竣工决算',
};
export const IC_VERSION_TYPES = Object.keys(IC_VERSION_TYPE_LABEL);
export const IC_LEVEL = {
  normal: { text: '正常', color: 'success' }, attention: { text: '关注', color: 'blue' }, warning: { text: '预警', color: 'orange' }, exceed: { text: '超限', color: 'red' },
};
export const IC_ROW_STATUS: Record<string, string> = { compared: '对比', new_item: '新增科目', removed_or_zero: '取消/为零' };
export const IC_MAPPING = {
  matched: { text: '自动匹配', color: 'success' }, manual: { text: '人工映射', color: 'blue' }, need_mapping: { text: '待映射', color: 'error' }, ignored: { text: '忽略', color: 'default' },
};
export const IC_VERSION_STATUS = { draft: { text: '草稿', color: 'default' }, confirmed: { text: '已确认', color: 'success' }, voided: { text: '已作废', color: 'default' } };

export const FEAS_INDICATOR_STATUS = { ok: { text: '正常', color: 'success' }, warning: { text: '预警', color: 'orange' }, no_solution: { text: '无解', color: 'default' } };
export const SENSITIVITY_LABEL: Record<string, string> = {
  construction_investment: '建设投资', electricity_price: '电价', power_generation: '发电量', operating_cost: '运营成本',
  construction_delay: '建设延期(年)', loan_interest_rate: '贷款利率', opening_input_vat_credit: '期初进项留抵',
};

export const FF_VERSION_STATUS = { draft: { text: '草稿', color: 'default' }, frozen: { text: '已冻结', color: 'success' } };
export const FF_RUN_STATUS = {
  queued: { text: '排队中', color: 'default' }, running: { text: '运行中', color: 'processing' }, succeeded: { text: '成功', color: 'success' }, failed: { text: '失败', color: 'error' },
};

/** 十进制字符串原样分组展示(万元 6 位小数等),不转 number。 */
export function Dec({ value }: { value: string | null | undefined }) {
  return <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{value == null ? '—' : formatMoney(value)}</span>;
}

export function RowErrors({ errors, title, max = 50 }: { errors: RowErrorDto[]; title: string; max?: number }) {
  if (!errors.length) return null;
  return (
    <Alert type="error" showIcon message={`${title}(${errors.length} 处)`}
      description={(
        <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 220, overflow: 'auto' }}>
          {errors.slice(0, max).map((e, i) => <li key={i}>{e.row ? `第 ${e.row} 行` : ''}{e.field ? `[${e.field}]` : ''}:{e.message}</li>)}
          {errors.length > max && <li>……另有 {errors.length - max} 处</li>}
        </ul>
      )} />
  );
}

export const StaleTag = ({ stale }: { stale: boolean }) => (stale ? <Tag color="warning">参数已修改,需重算</Tag> : <Tag color="success">结果最新</Tag>);
