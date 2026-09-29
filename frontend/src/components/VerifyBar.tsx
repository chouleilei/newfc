/**
 * 核验条(数据自检结论的承载位)。
 *
 * 背景:此前每页把「实际数已逐分勾稽」这类通过态结论渲染成 Alert —— 绿色大色块
 * 加三行金额,只为说一句「没事」。Alert 的语义是「这里有情况,你要处理」,用它
 * 承载通过态,等于每次进页面都要用最高视觉权重读一遍不含信息的结论,并把下方
 * 真正的数据挤出首屏(Analysis 一页最多 3 个此类色块)。
 *
 * 这里的分工是:
 * · 通过项 → 12px 核验徽标,与正文等高的单行 chip,不占额外的块级空间;
 * · 异常项 → 升格为 Alert,因为它才需要人工介入,此时它是页面唯一的那一块颜色;
 * · 明细金额 → 默认收进 Popover,审计可追溯,但不必常驻。
 *
 * 小澧助手对齐(方案《小澧助手全页面回答范围自动对齐开发计划》§7.3):
 * · VerifyItem.assistantTarget 携带 ownerKey/factKey/scopeRef —— 共享组件不从
 *   label 或 details 反推业务含义;
 * · 打开明细 Popover 时登记 verification fact 焦点与 verification_detail 浮层,
 *   关闭或 Escape 时清理,助手由此能回答「这个核验为什么没通过」;
 * · 有 details 的徽标具备 button 语义、tabIndex、aria-expanded/aria-controls,
 *   Enter/Space 打开,Escape 关闭并恢复焦点;聚合错误中的每个阻断项可单独聚焦。
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, Popover, Space, Typography, theme } from 'antd';
import { useOptionalAssistantSurface, useOptionalAssistantFocus } from '../assistant/contextHooks';

/** 三档结论:ok 仅徽标 / warn 徽标带橙 / bad 升格为 Alert。 */
export type CheckLevel = 'ok' | 'warn' | 'bad';

export interface ReconciliationFigures {
  /** 来源侧金额(分),利润方向 */
  sourceCents: number;
  /** 承接侧金额(分),利润方向 */
  displayedCents: number;
  /** 差额(分) */
  differenceCents: number;
}

/** 核验项的助手定位信息(§7.3)：内容由后端 verificationFacts 重新取得，不回传展示值。 */
export interface VerifyAssistantTarget {
  /** analysis:root / structure:root / evidence:metric:版本ID:指标ID */
  ownerKey: string;
  /** reconciliation、overspend、lagging、subtotal、unbudgeted、actual_none、coverage… */
  factKey: string;
  scopeRef?: Record<string, number | string>;
}

export interface VerifyItem {
  /** 同页去重用的稳定键:缺 key 时用 label 兜底 */
  key: string;
  level: CheckLevel;
  /** 徽标/标题文案,12px 语境下控制在 20 字内 */
  label: string;
  /** 收进 Popover 的明细行,如「来源实际 58,012.92 万元」 */
  details?: string[];
  /** 可点击跳转:把徽标变成行动入口(如「12 个科目超支」→ 执行分析) */
  onClick?: () => void;
  /** 跳转目标说明, hover 时提示 */
  actionHint?: string;
  /** 助手定位信息；存在时打开明细即成为当前核验焦点 */
  assistantTarget?: VerifyAssistantTarget;
}

/**
 * 三档语义色直接取 antd 主题令牌而非硬编码色值:深色模式由 ThemeProvider
 * 换掉 colorSuccess/colorWarning/colorError,这里不需要再维护一份暗色副本。
 */
const LEVEL_ICON: Record<CheckLevel, string> = {
  ok: 'ri-check-line',
  warn: 'ri-error-warning-line',
  bad: 'ri-error-warning-line',
};

function useLevelColor(): Record<CheckLevel, string> {
  const { token } = theme.useToken();
  return useMemo(
    () => ({ ok: token.colorSuccess, warn: token.colorWarning, bad: token.colorError }),
    [token.colorSuccess, token.colorWarning, token.colorError],
  );
}

/** 差额为 0 时两侧金额必然相等,只显示一次,不重复同一个数。 */
export function reconciliationDetails(figures: ReconciliationFigures, toWan: (cents: number) => string): string[] {
  const { sourceCents, displayedCents, differenceCents } = figures;
  if (differenceCents === 0) {
    return [`来源实际净额 ${toWan(sourceCents)} 万元`, `承接合计 ${toWan(displayedCents)} 万元`];
  }
  return [
    `来源实际净额 ${toWan(sourceCents)} 万元`,
    `预算叶子投影与未预算承接区合计 ${toWan(displayedCents)} 万元`,
    `差额 ${toWan(differenceCents)} 万元`,
  ];
}

function VerifyBadge({ item, color }: { item: VerifyItem; color: string }) {
  const [open, setOpen] = useState(false);
  const badgeRef = useRef<HTMLSpanElement | null>(null);
  const hasDetails = (item.details?.length ?? 0) > 0;
  const interactive = hasDetails || Boolean(item.onClick);
  const popoverId = useMemo(() => `verify-detail-${item.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`, [item.key]);

  /* 打开明细即登记核验焦点与 verification_detail 浮层；关闭(含 Escape)即清理。
     焦点生命周期(变化重登记、卸载清理)交给 Hook，避免手工管理漏掉卸载清理。 */
  useOptionalAssistantSurface({
    open: open && Boolean(item.assistantTarget),
    kind: 'popover',
    key: 'verification_detail',
  });
  useOptionalAssistantFocus(
    open && item.assistantTarget
      ? {
          kind: 'fact',
          factType: 'verification',
          ownerKey: item.assistantTarget.ownerKey,
          factKey: item.assistantTarget.factKey,
          ...(item.assistantTarget.scopeRef ? { scopeRef: item.assistantTarget.scopeRef } : {}),
        }
      : null,
    item.label,
  );

  const changeOpen = useCallback((next: boolean, viaKeyboard = false) => {
    setOpen(next);
    // 只有键盘 Escape 关闭才把焦点还给徽标：点击外部(用户已主动点击别处)再抢回焦点,
    // 会打断用户接下来的输入/点击,是典型的焦点劫持。
    if (!next && viaKeyboard) {
      window.setTimeout(() => badgeRef.current?.focus({ preventScroll: true }), 0);
    }
  }, []);

  const body = (
    <span
      ref={badgeRef}
      className="bd-verify-badge"
      data-level={item.level}
      data-testid={`verify-badge-${item.key}`}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-expanded={hasDetails ? open : undefined}
      aria-controls={hasDetails ? popoverId : undefined}
      title={item.onClick ? item.actionHint : undefined}
      onClick={item.onClick}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.preventDefault();
          e.stopPropagation();
          changeOpen(false, true);
          return;
        }
        if ((e.key === 'Enter' || e.key === ' ') && (item.onClick || hasDetails)) {
          e.preventDefault();
          if (item.onClick) item.onClick();
          else changeOpen(!open);
        }
      }}
    >
      <i className={LEVEL_ICON[item.level]} aria-hidden style={{ color, fontSize: 12 }} />
      <span>{item.label}</span>
      {hasDetails && <i className="ri-arrow-down-s-line bd-verify-caret" aria-hidden />}
    </span>
  );

  if (!hasDetails) return body;

  return (
    <Popover
      open={open}
      onOpenChange={(next: boolean) => changeOpen(next)}
      trigger="click"
      placement="bottomLeft"
      content={
        <div style={{ maxWidth: 320 }} id={popoverId}>
          {item.details!.map((line) => (
            <div key={line} style={{ fontSize: 12, lineHeight: 1.9, whiteSpace: 'nowrap' }}>{line}</div>
          ))}
        </div>
      }
    >
      {body}
    </Popover>
  );
}

/** 聚合错误中的单个阻断项：明细内联展示，每项可单独聚焦(§8.5)，不丢失单项。
 *  只有带真实动作(onClick)的项才是可交互按钮；仅携带 assistantTarget 的项
 *  不给 button 语义——可聚焦但 Enter/Space 无行为的假按钮比纯文本更误导。
 *  带 assistantTarget 的阻断项同时登记核验焦点：bad 级结论是用户最可能追问
 *  「这项为什么没通过」的对象，徽标有焦点而错误 Alert 里没有，等于把最严重的
 *  问题排除在助手可回答范围之外。 */
function BlockingItem({ item }: { item: VerifyItem }) {
  const focusable = Boolean(item.onClick);
  useOptionalAssistantFocus(
    item.assistantTarget
      ? {
          kind: 'fact',
          factType: 'verification',
          ownerKey: item.assistantTarget.ownerKey,
          factKey: item.assistantTarget.factKey,
          ...(item.assistantTarget.scopeRef ? { scopeRef: item.assistantTarget.scopeRef } : {}),
        }
      : null,
    item.label,
  );
  return (
    <div
      style={{ fontSize: 12 }}
      role={focusable ? 'button' : undefined}
      tabIndex={focusable ? 0 : undefined}
      data-testid={`verify-blocking-${item.key}`}
      onClick={item.onClick}
      onKeyDown={item.onClick
        ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.onClick?.(); } }
        : undefined}
    >
      <Typography.Text strong style={{ fontSize: 12 }}>{item.label}</Typography.Text>
      {item.details?.length ? <Typography.Text type="secondary" style={{ fontSize: 12 }}> · {item.details.join('；')}</Typography.Text> : null}
    </div>
  );
}

/**
 * 页面级核验条:一页至多一条,聚合该页全部自检结论。
 *
 * 通过项只留徽标;只要存在 bad 项,就把全部 bad 文案收进一条 error Alert
 * (不再逐条铺色块),warn/ok 项仍在同行的徽标里,供需要的人展开核对。
 */
export function VerifyBar({ items, style }: { items: VerifyItem[]; style?: React.CSSProperties }) {
  const levelColor = useLevelColor();
  /** 同一结论在多个数据源里出现时按 key 去重,避免同页渲染两遍。 */
  const unique = useMemo(() => {
    const seen = new Set<string>();
    return items.filter((item) => {
      const id = item.key || item.label;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }, [items]);

  const blocking = unique.filter((item) => item.level === 'bad');
  const rest = unique.filter((item) => item.level !== 'bad');

  if (unique.length === 0) return null;

  return (
    <div className="bd-verify-bar" style={style}>
      {blocking.length > 0 && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: rest.length > 0 ? 8 : 0 }}
          message={blocking.length === 1 ? blocking[0].label : `${blocking.length} 项核验未通过，数据暂不可信`}
          description={
            <Space direction="vertical" size={2}>
              {/* 多个阻断项逐条渲染、可单独聚焦打开明细，不因合并为一条 Alert 而丢失单项(§7.3)。 */}
              {blocking.map((item) => <BlockingItem key={item.key || item.label} item={item} />)}
            </Space>
          }
        />
      )}
      {rest.length > 0 && (
        <div className="bd-verify-row">
          {rest.map((item) => <VerifyBadge key={item.key || item.label} item={item} color={levelColor[item.level]} />)}
        </div>
      )}
    </div>
  );
}
