import { chatRequestSchema, type ChatRequest, type PreviewRequest } from '../contracts/assistant';
import { AppError, Errors } from '../core/errors';
import { parseAssistantPageContext } from './page-context';
function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value == null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw Errors.validation(`${label}必须是正整数`);
  return n;
}
export function parseChatRequest(value: unknown): ChatRequest {
  if (value && typeof value === 'object' && 'context' in value) throw new AppError('CONTEXT_INVALID', '旧助手协议已停用，请刷新页面后重试；本次请求未执行', 400);
  const parsed = chatRequestSchema.safeParse(value);
  if (!parsed.success) throw new AppError('CONTEXT_INVALID', `助手请求无效：${parsed.error.issues.map((i) => i.message).join('; ')}`, 400);
  const pageContext = parseAssistantPageContext(parsed.data.pageContext);
  return { ...parsed.data, pageContext };
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
