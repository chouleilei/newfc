import { Alert, Button, Typography } from 'antd';
import type { ActualTask } from './useActualDraft';

/** "2026-08-31" -> "8 月 31 日" */
export function formatCnMonthDay(date: string): string {
  return `${Number(date.slice(5, 7))} 月 ${Number(date.slice(8, 10))} 日`;
}

/**
 * 期间摘要条(UX-08):表格与保存按钮附近持续显示本次录入的累计期间与保存后果;
 * 可见筛选范围与实际保存影响范围(整年整包)不一致时给出明确摘要;
 * 普通更新截止日早于当前累计截止日时说明原因并给历史补录入口。
 */
export function PeriodSummary(props: {
  year: number;
  task: ActualTask;
  /** 有效累计截止日(显式选择或当前任务的服务器截止),未选为 null */
  cutoff: string | null;
  /** 服务器现有累计截止日;本年度尚无实际时为 null */
  serverCutoff: string | null;
  /** 当前可见范围是否小于保存影响范围(组织范围收窄/筛选/存在视图外待保存项) */
  scopeNarrowed: boolean;
  /** 当前累计任务下选择了早于服务器截止日的日期时,提供历史补录入口 */
  onSwitchToHistory?: (date: string) => void;
}) {
  const { year, task, cutoff, serverCutoff } = props;
  const earlyCutoff = task === 'current' && cutoff != null && serverCutoff != null && cutoff < serverCutoff;

  const mainText = cutoff
    ? task === 'history'
      ? `补录 ${year} 年 1 月 1 日至 ${formatCnMonthDay(cutoff)} 的历史实际。保存后仅追加该日期的历史快照，不更新当前累计。`
      : `录入 ${year} 年 1 月 1 日至 ${formatCnMonthDay(cutoff)} 累计实际。保存后更新当前累计，并保留一次历史记录。`
    : task === 'history'
      ? `请选择 ${year} 年要补录的历史截止日期。历史补录从空白开始，仅追加该日期的历史快照，不更新当前累计。`
      : `请选择 ${year} 年的累计截止日期（本年度尚无已保存的累计实际，没有默认期间）。`;

  return (
    <div style={{ marginBottom: 8 }}>
      <Alert
        type={cutoff ? 'info' : 'warning'}
        showIcon
        message={
          <span style={{ fontSize: 13 }}>
            {mainText}
            {props.scopeNarrowed && (
              <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                保存影响 {year} 年全部组织的整包数据，不止当前视图显示的范围；未修改的组织按服务器原值一并提交，不会被清空。
              </Typography.Text>
            )}
          </span>
        }
      />
      {earlyCutoff && cutoff && serverCutoff && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 8 }}
          message={`普通更新不能早于当前累计截止日 ${serverCutoff} 保存`}
          description={
            <span style={{ fontSize: 12 }}>
              当前选择的截止日为 {cutoff}，早于服务器现有累计截止日。请改选不早于该日的截止日；如要补充更早期间的历史数据，请改用「补录历史快照」。
              {props.onSwitchToHistory && (
                <Button type="link" size="small" style={{ padding: 0, marginLeft: 4 }} onClick={() => props.onSwitchToHistory!(cutoff)}>
                  切换为历史补录（截止 {cutoff}）
                </Button>
              )}
            </span>
          }
        />
      )}
    </div>
  );
}
