/**
 * AssistantScopeBar(现行 specs/ai.md 页面上下文契约§10.1；UX-26)。
 *
 * 助手输入区上方的一行范围条，如实展示本轮发送会携带的页面范围：
 * - ready：「已对齐 · {页面} · 年度 · 版本 …」；
 * - loading：「正在读取当前页面范围」；
 * - error：「当前页面范围不可用」+ 原因；
 * - dirty：「含 N 项本轮未保存输入」——范围数值对应已保存数据，未保存输入只作草稿参考；
 * - 有当前焦点时追加「当前对象 · {label}」及「解释这个差异 / 查看计算依据」入口(UX-26)。
 *
 * 范围显示名称优先(UX-26)：版本/快照/组织/科目先显示业务名称，内部 ID 以 #n 补充；
 * 名称目录未加载时回退 #id，不编造名称。
 *
 * 数据只读自 AssistantContextRegistry 的视图；这里展示的是页面声明的范围，
 * 后端返回的权威 contextSummary 在回答卡片上另行展示。
 */
import { useLocation } from 'react-router-dom';
import { Tag, Tooltip, Typography } from 'antd';
import { useOptionalAssistantRegistryView } from '../../assistant/AssistantContextRegistry';
import { useAssistant } from '../../assistant/AssistantProvider';
import { PAGE_LABEL } from '../../assistant/pageContext';
import { describeScopeEntry, focusActions, SCOPE_FIELD_LABEL } from '../../assistant/scopeDisplay';
import type { PageScope } from '../../assistant/context';

export function AssistantScopeBar() {
  const view = useOptionalAssistantRegistryView();
  const { versions, batches, orgs, accounts, send, openDock, sending } = useAssistant();
  const location = useLocation();
  /** 小窗之外(完整页 /assistant)不需要再 openDock；发送仍走同一 send。 */
  const onAssistantPage = location.pathname === '/assistant';

  if (!view || !view.pageKey) {
    return (
      <div className="newfc-ai-scope" data-testid="assistant-scope-bar">
        <span className="newfc-ai-scope-key">回答范围</span>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>正在读取当前页面范围</Typography.Text>
      </div>
    );
  }

  const pageLabel = PAGE_LABEL[view.pageKey] ?? view.pageKey;
  const scopeEntries = (Object.keys(SCOPE_FIELD_LABEL) as (keyof PageScope)[])
    .filter((field) => view.scope[field] != null)
    .map((field) => describeScopeEntry(field, view.scope[field] as string | number, {
      versionName: (id) => versions.find((row) => row.id === id)?.name,
      batchLabel: (id) => {
        const batch = batches.find((row) => row.id === id);
        return batch ? `截至 ${batch.snapshot_date} rev${batch.revision}` : undefined;
      },
      org: (id) => orgs.find((row) => row.id === id),
      account: (id) => accounts.find((row) => row.id === id),
    }));

  /** 当前对象动作：打开小窗(完整页则直接发送)并带着冻结的页面快照提问。 */
  const askAboutFocus = (prompt: string) => {
    if (sending) return;
    if (!onAssistantPage) openDock();
    void send(prompt);
  };

  return (
    <div className="newfc-ai-scope" data-testid="assistant-scope-bar">
      <Tooltip title="发送时会带上当前页面的业务范围，回答自动对齐你正在看的内容；问题里明确指定的范围优先于页面范围">
        <span className="newfc-ai-scope-key">回答范围</span>
      </Tooltip>
      {view.ready === 'loading' ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }} data-testid="assistant-scope-loading">
          正在读取当前页面范围
        </Typography.Text>
      ) : view.ready === 'error' ? (
        <Tooltip title={view.notReadyReason ?? undefined}>
          <Typography.Text type="danger" style={{ fontSize: 12 }} data-testid="assistant-scope-error">
            当前页面范围不可用{view.notReadyReason ? `：${view.notReadyReason}` : ''}
          </Typography.Text>
        </Tooltip>
      ) : (
        <>
          <span className="newfc-ai-scope-val newfc-ai-scope-val-strong" data-testid="assistant-scope-page">已对齐 · {pageLabel}</span>
          {scopeEntries.map((text) => <span key={text} className="newfc-ai-scope-val">{text}</span>)}
        </>
      )}
      {view.dirty ? (
        <Tooltip title="上方范围对应已保存数据；本轮未保存输入只作为草稿随问题供分析参考，不会写入。创建正式写操作预览前请先保存。">
          <Tag bordered={false} className="newfc-ai-meta" color="orange" data-testid="assistant-scope-dirty">
            含 {view.dirtyCount > 0 ? `${view.dirtyCount} 项` : ''}本轮未保存输入
          </Tag>
        </Tooltip>
      ) : null}
      {view.focusLabel ? (
        <>
          <Tooltip title="最近点击的行、单元格、图表点或核验项">
            <Tag bordered={false} className="newfc-ai-meta" color="blue" data-testid="assistant-scope-focus">
              当前对象 · {view.focusLabel}
            </Tag>
          </Tooltip>
          {focusActions(view.focusLabel).map((action) => (
            <Typography.Link
              key={action.key}
              style={{ fontSize: 12 }}
              disabled={sending}
              data-testid={`assistant-focus-action-${action.key}`}
              onClick={() => askAboutFocus(action.prompt)}
            >
              {action.label}
            </Typography.Link>
          ))}
        </>
      ) : null}
    </div>
  );
}
