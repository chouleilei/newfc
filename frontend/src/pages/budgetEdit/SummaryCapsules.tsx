import MoneyText from '../../components/MoneyText';
import { financeColor, useThemeMode } from '../../theme';
import type { SummaryResponse } from './types';

/**
 * 顶部财务指标胶囊条:收入/成本/费用/利润总额(万元,利润方向)。
 *
 * 用色纪律(theme.tsx:33-48):三档是**类型色**不是**状态色** ——
 * 收入=蓝、成本=橙、费用=紫,红绿只留给「好/坏」。此处曾经把费用涂红(#d91f1f)、
 * 收入涂绿(#008a50),于是「期间费用合计」与「费用超支」同色,读者只能靠上下文猜
 * 颜色在说类型还是在说好坏。现统一取 financeColor(mode),亮暗自换挡。
 */
export function SummaryCapsules({ summary }: { summary: SummaryResponse | null }) {
  const { mode } = useThemeMode();
  const fc = financeColor(mode);
  const income = summary?.totalsByAccountType.income ?? 0;
  const cost = summary?.totalsByAccountType.cost ?? 0;
  const expense = summary?.totalsByAccountType.expense ?? 0;
  const profit = income + cost + expense;

  const items = [
    { label: '营业收入合计', cents: income, color: fc.income },
    /* 成本/费用以利润方向存储(负),界面口径显示绝对额,故取负 —— 翻转归调用方 */
    { label: '营业成本合计', cents: -cost, color: fc.cost },
    { label: '期间费用合计', cents: -expense, color: fc.expense },
    { label: '利润总额', cents: profit, color: profit >= 0 ? fc.income : fc.expense },
  ];

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: 12,
        marginBottom: 12,
      }}
    >
      {items.map((item) => (
        <div key={item.label} style={{ padding: '10px 14px', background: 'var(--newfc-header)', borderRadius: 8, border: '1px solid var(--newfc-border-subtle)' }}>
          <div style={{ fontSize: 12, color: 'var(--newfc-text-tertiary)' }}>{item.label}</div>
          <MoneyText cents={item.cents} size="lg" color={item.color} style={{ marginTop: 2 }} />
        </div>
      ))}
    </div>
  );
}
