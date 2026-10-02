/**
 * 事实来源与引用的共享定义。
 *
 * 单独成文件是为了让 facts.ts(自然语言 → 只读工具)与 report-draft.ts(报告生成)
 * 都能复用同一套引用口径,而不产生模块循环依赖。
 */
import type { AssistantCitation } from './schemas';

export interface FactSource {
  period?: string;
  orgScopeId?: number;
  references?: { kind: string; id: number; label: string; path: string; hash?: string }[];
  year?: number;
  budgetVersionId?: number | null;
  targetVersionId?: number | null;
  actualSnapshotId?: number | null;
  treeSnapshotIds?: { org?: number | null; account?: number | null };
  asOf?: string;
}

export interface FactRecord {
  type: string;
  data: unknown;
  source: FactSource;
}

export function citationsForFacts(facts: FactRecord[]): AssistantCitation[] {
  return facts.map((entry) => ({
    source: entry.type,
    period: entry.source.period, orgScopeId: entry.source.orgScopeId, references: entry.source.references,
    asOf: entry.source.asOf || new Date().toISOString(),
    year: entry.source.year,
    budgetVersionId: entry.source.budgetVersionId ?? null,
    actualSnapshotId: entry.source.actualSnapshotId ?? null,
    targetVersionId: entry.source.targetVersionId,
    treeSnapshotIds: entry.source.treeSnapshotIds,
  }));
}
