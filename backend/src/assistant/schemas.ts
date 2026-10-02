import type { DomainContext } from './domain-scope';
import { Errors } from '../core/errors';
import { normalizeContext } from './context';
export interface AssistantContext extends DomainContext {
  year?: number;
  budgetVersionId?: number;
  targetVersionId?: number;
  actualSnapshotId?: number;
  importBatchId?: number;
  page?: string;
  orgId?: number;
  accountId?: number;
}
export interface ChatRequest {
  conversationId?: number;
  message: string;
  context?: AssistantContext;
  /**
   * AssistantPageContextV2(§5.1)：页面语义快照。原始对象透传到
   * BackendContextResolver 做白名单与数据库核验，这里不提前裁剪。
   */
  pageContext?: unknown;
}
export interface AssistantCitation {
  period?: string;
  orgScopeId?: number;
  references?: { kind: string; id: number; label: string; path: string; hash?: string }[];
  source: string;
  asOf: string;
  year?: number;
  budgetVersionId?: number | null;
  targetVersionId?: number | null;
  actualSnapshotId?: number | null;
  treeSnapshotIds?: { org?: number | null; account?: number | null };
}
export interface AssistantNavigation {
  page: string;
  path: string;
  label: string;
  reason: string;
  params?: Record<string, string | number>;
}
export interface AssistantResponse {
  text: string;
  facts: unknown[];
  citations: AssistantCitation[];
  suggestions: string[];
  action: unknown | null;
  /** 页面导航目标(方案 4.1);无导航意图时为 null */
  navigation: AssistantNavigation | null;
}
export type AssistantActionStatus = 'pending' | 'confirmed' | 'cancelled' | 'expired';
export type AssistantActionType = 'budget_draft' | 'scenario' | 'copy_budget' | 'bulk_adjustment' | 'basis_text' | 'export';
export interface PreviewRequest {
  type: AssistantActionType | string;
  params: Record<string, unknown>;
  conversationId?: number;
  idempotencyKey?: string;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value == null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw Errors.validation(`${label}必须是正整数`);
  return n;
}
export function parseChatRequest(value: unknown): ChatRequest {
  if (!value || typeof value !== 'object') throw Errors.validation('请求体必须是对象');
  const v = value as Record<string, unknown>; const message = typeof v.message === 'string' ? v.message.trim() : '';
  if (!message || message.length > 20_000) throw Errors.validation('message 必须是 1-20000 字符');
  const conversationId = optionalPositiveInteger(v.conversationId, 'conversationId');
  try {
    return {
      conversationId,
      message,
      context: v.context == null ? undefined : normalizeContext(v.context),
      pageContext: v.pageContext == null ? undefined : v.pageContext,
    };
  } catch (err) {
    throw Errors.validation(err instanceof Error ? err.message : 'context格式不正确');
  }
}
export function parsePreviewRequest(value: unknown): PreviewRequest {
  if (!value || typeof value !== 'object') throw Errors.validation('请求体必须是对象');
  const v = value as Record<string, unknown>;
  if (typeof v.type !== 'string' || !v.type.trim()) throw Errors.validation('操作类型不能为空');
  const params = (v.params && typeof v.params === 'object' && !Array.isArray(v.params) ? v.params : {}) as Record<string, unknown>;
  const conversationId = optionalPositiveInteger(v.conversationId, 'conversationId');
  if (v.idempotencyKey != null && typeof v.idempotencyKey !== 'string' && typeof v.idempotencyKey !== 'number') throw Errors.validation('idempotencyKey必须是字符串');
  const idempotencyKey = v.idempotencyKey == null ? undefined : String(v.idempotencyKey).trim();
  if (idempotencyKey !== undefined && (idempotencyKey.length < 1 || idempotencyKey.length > 200)) throw Errors.validation('idempotencyKey 长度必须为 1-200 字符');
  return { type: v.type.trim(), params, conversationId, idempotencyKey };
}
