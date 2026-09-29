import type { AssistantContext } from './schemas';
/** 仅保留当前任务所需的上下文 ID，避免把全库数据发送给模型。 */
export function normalizeContext(input: unknown): AssistantContext {
  if (input != null && (typeof input !== 'object' || Array.isArray(input))) throw new Error('context必须是对象');
  const c = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const integer = (value: unknown, label: string, min = 1): number | undefined => {
    if (value == null || value === '') return undefined;
    if (typeof value !== 'number' && typeof value !== 'string') throw new Error(`${label}必须是合法整数`);
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(n) || n < min) throw new Error(`${label}必须是合法整数`);
    return n;
  };
  const year = integer(c.year, 'year', 1900);
  if (year != null && year > 9999) throw new Error('year必须是 1900-9999');
  return {
    year,
    budgetVersionId: integer(c.budgetVersionId, 'budgetVersionId'),
    targetVersionId: integer(c.targetVersionId, 'targetVersionId'),
    actualSnapshotId: integer(c.actualSnapshotId, 'actualSnapshotId'),
    importBatchId: integer(c.importBatchId, 'importBatchId'),
    orgId: integer(c.orgId, 'orgId'),
    accountId: integer(c.accountId, 'accountId'),
    page: typeof c.page === 'string' ? c.page.trim().slice(0, 80) : undefined,
  };
}
