/**
 * 助手写操作的确认结果表达（UX-26）。
 *
 * 确认成功后：
 * - summarizeActionResult 用业务语言说明写入了什么（目标、数量）；
 * - actionResultLinks 给出「查看结果」跳转（带范围的对应页面）。
 *
 * 只读前端展示：数值与目标 ID 均来自后端 preview/result，不在此推断业务规则。
 */
import type { AssistantAction } from '@contracts/assistant';

export interface ActionResultLink {
  path: string;
  label: string;
}

type ActionLike = Pick<AssistantAction, 'type' | 'status' | 'preview' | 'result'>;

function positiveId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** 确认结果的业务化摘要；确认前/无可读结果时返回 null。 */
export function summarizeActionResult(action: ActionLike): string | null {
  if (action.status !== 'confirmed' || !action.result) return null;
  const result = action.result as Record<string, any>;
  switch (action.type) {
    case 'budget_draft':
    case 'copy_budget': {
      const id = positiveId(result.id);
      const name = typeof result.name === 'string' ? result.name : null;
      const year = typeof result.year === 'number' ? `${result.year} 年` : null;
      if (id == null) return null;
      return `已生成新${action.type === 'copy_budget' ? '修订' : '草稿'}版本${name ? `「${name}」` : ''}（${[year, `#${id}`].filter(Boolean).join(' · ')}），当前采用版本未变化`;
    }
    case 'bulk_adjustment': {
      const parts = [
        typeof result.saved === 'number' ? `写入 ${result.saved} 条` : null,
        typeof result.deleted === 'number' && result.deleted > 0 ? `清除 ${result.deleted} 条` : null,
        typeof result.cellNotesSaved === 'number' && result.cellNotesSaved > 0 ? `汇总备注 ${result.cellNotesSaved} 条` : null,
      ].filter(Boolean);
      return parts.length ? `已按确认内容更新草稿明细：${parts.join('，')}` : null;
    }
    case 'basis_text':
      return positiveId(result.insightId) != null ? `已保存测算依据草稿（洞察 #${result.insightId}）` : null;
    case 'scenario':
      return '情景测算完成（未写入任何数据）';
    case 'export':
      return typeof result.filename === 'string' ? `导出文件已生成：${result.filename}` : '导出文件已生成';
    default:
      return null;
  }
}

/** 确认成功后的「查看结果」入口；无对应页面时返回空数组。 */
export function actionResultLinks(action: ActionLike): ActionResultLink[] {
  if (action.status !== 'confirmed') return [];
  const result = (action.result ?? {}) as Record<string, any>;
  const preview = (action.preview ?? {}) as Record<string, any>;
  switch (action.type) {
    case 'budget_draft':
    case 'copy_budget': {
      const id = positiveId(result.id);
      return id == null ? [] : [{ path: `/budget/${id}`, label: '查看结果（打开新版本）' }];
    }
    case 'bulk_adjustment': {
      const id = positiveId(preview.versionId);
      return id == null ? [] : [{ path: `/budget/${id}`, label: '查看结果（打开目标版本明细）' }];
    }
    case 'basis_text':
      return positiveId(result.insightId) != null
        ? [{ path: '/assistant', label: '查看结果（助手页已保存洞察）' }]
        : [];
    default:
      /* scenario 不落库、export 走下载按钮，均无页面跳转 */
      return [];
  }
}
