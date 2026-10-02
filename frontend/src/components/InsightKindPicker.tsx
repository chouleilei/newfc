import { Segmented } from 'antd';
import { INSIGHT_KINDS } from '../pages/assistantShared/insightKinds';
import type { InsightKind } from '@contracts/assistant';

/**
 * 洞察类型选择器:新建洞察(Insights 页)与保存洞察(Assistant 页)共用,
 * 避免两处同款 Segmented 再漂移。
 *
 * 9 个类型的单行 Segmented 实际宽约 990px,会溢出 520px 弹窗右缘;
 * 根因是 antd Segmented 根节点 inline-block,外层 flexWrap 不生效。
 * 这里统一挂 .newfc-segmented-chips(见 index.css 6b):内层 group 换行、
 * 选项变独立 chip,自然折成 2~3 行,明暗主题共用同一套 CSS 变量。
 */
export function InsightKindPicker({ value, onChange }: {
  value: InsightKind;
  onChange: (value: InsightKind) => void;
}) {
  return (
    <Segmented
      className="newfc-segmented-chips"
      options={INSIGHT_KINDS.map((row) => ({ value: row.value, label: row.label }))}
      value={value}
      onChange={(v) => onChange(v as InsightKind)}
    />
  );
}
