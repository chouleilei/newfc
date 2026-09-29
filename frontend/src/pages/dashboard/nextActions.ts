/**
 * 首页「下一步」行动入口(方案《易用性与直觉化交互实施方案》4.7,任务 UX-24)。
 *
 * 纯函数:输入全部来自 /api/dashboard 的后台事实(版本状态、快照批次存在性、
 * 结构检查)与当前选中年度,输出有限数量(至多 MAX_ACTIONS 条)的行动入口。
 *
 * 口径约束:
 * - 待办依据必须来自后台事实,不因月份过去断言漏报;无月末快照只客观表述
 *   「尚无截至 X 月末的快照」,是否应录入交由用户判断;
 * - 每条入口携带具体业务范围(版本 ID / 年度),跳转目标页经各自 URL 契约接收;
 * - 一切就绪时用稳定入口补齐至少 MIN_ACTIONS 条,保证首页始终有可用的下一步。
 */

export interface NextAction {
  key: string;
  /** remixicon 类名,由渲染层拼 <i className={...}> */
  icon: string;
  title: string;
  desc: string;
  path: string;
  tone?: 'warn' | 'bad';
}

export interface NextActionsInput {
  /** 当前选中年度(来自首页年度选择,已做归属校验)。 */
  year: number | null;
  /** 选中年度的当前采用预算版本。 */
  currentVersion: { id: number; name: string } | null;
  orgCount: number;
  accountCount: number;
  /** 主数据结构检查是否全部通过。 */
  structureOk: boolean;
  /** 结构问题条数(structureOk=false 时用于描述)。 */
  structureProblemCount: number;
  recentDraft: { id: number; year: number; name: string; kind: string; updated_at: string } | null;
  pendingAdoption: { year: number; kind: string; lockedCount: number; latestLockedName: string | null }[];
  yearActuals: { year: number; latest_snapshot: string; batch_count: number }[];
  /** 首页完成率报表派生的超支科目数(成本费用累计实际超全年预算)。 */
  overspendCount: number;
  /** 可注入的「今天」,便于测试月末快照的客观表述。 */
  today?: Date;
}

export const MAX_ACTIONS = 4;
export const MIN_ACTIONS = 3;

function kindLabel(kind: string): string {
  return kind === 'forecast' ? '预测' : '预算';
}

/** 该月最后一天的 ISO 日期(day 0 of next month),与 Dashboard 月度覆盖同一算法。 */
function monthEndDate(year: number, month: number): string {
  const last = new Date(year, month, 0).getDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

export function buildNextActions(input: NextActionsInput): NextAction[] {
  const actions: NextAction[] = [];

  // 1. 组织/科目未就绪 → 定位配置入口(最先,一切业务的前提)
  if (input.orgCount === 0) {
    actions.push({
      key: 'setup-org', icon: 'ri-organization-chart', tone: 'warn',
      title: '建立组织树',
      desc: '尚无组织节点;预算编制与实际录入都需要先有组织',
      path: '/org',
    });
  }
  if (input.accountCount === 0) {
    actions.push({
      key: 'setup-account', icon: 'ri-node-tree', tone: 'warn',
      title: '建立科目树',
      desc: '尚无科目节点;预算编制与实际录入都需要先有科目',
      path: '/account',
    });
  }
  // 主数据存在但结构检查未通过 → 指向健康体检
  if (input.orgCount > 0 && input.accountCount > 0 && !input.structureOk) {
    actions.push({
      key: 'structure', icon: 'ri-health-book-line', tone: 'warn',
      title: '处理主数据结构问题',
      desc: `结构检查发现 ${input.structureProblemCount} 个问题,处理后再继续`,
      path: '/master-health',
    });
  }

  // 2. 已有草稿 → 进入最近编制(携带版本 ID)
  const draft = input.recentDraft;
  if (draft) {
    actions.push({
      key: 'draft', icon: 'ri-edit-box-line',
      title: `继续编制「${draft.name}」`,
      desc: `${draft.year} 年${kindLabel(draft.kind)}草稿 · 最近更新 ${draft.updated_at.slice(0, 16).replace('T', ' ')}`,
      path: `/budget/${draft.id}`,
    });
  }

  // 3. 有定稿但没有当前采用版本 → 提示选择(跳版本列表对应年度)
  for (const gap of input.pendingAdoption.slice(0, 2)) {
    actions.push({
      key: `adopt-${gap.year}-${gap.kind}`, icon: 'ri-flag-line', tone: 'warn',
      title: `选择 ${gap.year} 年${kindLabel(gap.kind)}的当前采用版本`,
      desc: `已有 ${gap.lockedCount} 个定稿版本${gap.latestLockedName ? `(最新「${gap.latestLockedName}」)` : ''},尚未设为当前采用`,
      path: `/budget?year=${gap.year}`,
    });
  }

  // 4. 实际数据状态 → 进入对应年度实际页(带 year);只陈述事实,不断言逾期
  if (input.year != null) {
    const ya = input.yearActuals.find((row) => row.year === input.year);
    if (!ya) {
      actions.push({
        key: 'actual', icon: 'ri-database-2-line',
        title: `录入 ${input.year} 年实际`,
        desc: '本年度尚无实际快照',
        path: `/actual?year=${input.year}`,
      });
    } else {
      let objective = '';
      const today = input.today ?? new Date();
      const prevMonth = today.getMonth(); // 0-based:当前月之前最近一个完整月
      if (input.year === today.getFullYear() && prevMonth >= 1 && ya.latest_snapshot < monthEndDate(input.year, prevMonth)) {
        objective = `;尚无截至 ${prevMonth} 月末的快照`;
      }
      actions.push({
        key: 'actual', icon: 'ri-database-2-line',
        title: `更新 ${input.year} 年实际`,
        desc: `最新快照截至 ${ya.latest_snapshot}${objective}`,
        path: `/actual?year=${input.year}`,
      });
    }
  }

  // 5. 有异常 → 指向预警中心对应筛选(年度 + 版本)
  if (input.overspendCount > 0 && input.year != null) {
    const versionParam = input.currentVersion ? `&version=${input.currentVersion.id}` : '';
    actions.push({
      key: 'anomaly', icon: 'ri-alert-line', tone: 'bad',
      title: '查看异常预警',
      desc: `${input.overspendCount} 个成本费用科目累计实际已超全年预算`,
      path: `/alerts?year=${input.year}${versionParam}`,
    });
  }

  // 一切就绪时补稳定入口,保证首页始终有可用的下一步
  if (actions.length < MIN_ACTIONS && input.currentVersion && !actions.some((a) => a.key === 'draft')) {
    actions.push({
      key: 'open-current', icon: 'ri-edit-box-line',
      title: '打开当前预算',
      desc: `当前采用「${input.currentVersion.name}」`,
      path: `/budget/${input.currentVersion.id}`,
    });
  }
  if (actions.length < MIN_ACTIONS) {
    actions.push({
      key: 'finance', icon: 'ri-arrow-left-right-line',
      title: '从财务系统转换',
      desc: '余额表转入实际数',
      path: '/finance',
    });
  }

  return actions.slice(0, MAX_ACTIONS);
}
