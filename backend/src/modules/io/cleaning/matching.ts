import type { DB } from '../../../db/connection';
import { Errors } from '../../../core/errors';
import { computeLeafIds, pathOf, type TreeNodeRow } from '../../../core/tree';
import { fuzzySimilarity, type SimilarityTarget } from '../../../core/text-similarity';
import * as budget from '../../budget/budget.service';
import { listRows } from '../../actual/actual.helpers';
import { loadSnapshotNodes } from '../../tree/snapshot';
import type { CleaningNameMapping, CleaningTarget, CleaningTargetKind } from './plan';
import { normalizeSourceText } from './plan';

export interface MatchingTarget {
  id: number;
  code: string;
  name: string;
  path: string;
  status: string;
  type?: string;
  unit?: string;
  quantityAgg?: string;
}

export interface MatchingContext {
  targetKind: CleaningTargetKind;
  orgRows: TreeNodeRow[];
  accountRows: TreeNodeRow[];
  orgTargets: MatchingTarget[];
  accountTargets: MatchingTarget[];
  orgById: Map<number, MatchingTarget>;
  accountById: Map<number, MatchingTarget>;
  orgByCode: Map<string, MatchingTarget>;
  accountByCode: Map<string, MatchingTarget>;
}

export interface MatchCandidate {
  id: number;
  code: string;
  name: string;
  path: string;
  status: string;
  score: number;
}

export interface EntityMatch {
  sourceText: string;
  target?: MatchingTarget;
  method?: 'code' | 'manual' | 'alias' | 'name';
  candidates: MatchCandidate[];
  invalidManualTarget?: string;
  staleAliasTarget?: string;
  conflictingExactTargets?: string;
}

export function createMatchingContext(db: DB, target: CleaningTarget): MatchingContext {
  let orgRows: TreeNodeRow[];
  let accountRows: TreeNodeRow[];
  if (target.targetKind === 'budget') {
    const version = budget.getVersion(db, target.versionId!);
    if (version.status !== 'draft') throw Errors.conflict('目标预算版本不是草稿，不能创建导入预览');
    orgRows = loadSnapshotNodes(db, version.org_tree_snapshot_id);
    accountRows = loadSnapshotNodes(db, version.account_tree_snapshot_id);
  } else {
    orgRows = listRows(db, 'org');
    accountRows = listRows(db, 'account');
  }
  const toTargets = (rows: TreeNodeRow[], kind: 'org' | 'account'): MatchingTarget[] => {
    const leaves = computeLeafIds(rows);
    return rows.filter((row) => leaves.has(row.id) && (target.targetKind !== 'budget' || row.status === 'active')).map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      path: pathOf(rows, row.id),
      status: row.status,
      ...(kind === 'account' ? { type: row.type, unit: row.unit, quantityAgg: row.quantity_agg ?? 'sum' } : {}),
    }));
  };
  const orgTargets = toTargets(orgRows, 'org');
  const accountTargets = toTargets(accountRows, 'account');
  return {
    targetKind: target.targetKind,
    orgRows,
    accountRows,
    orgTargets,
    accountTargets,
    orgById: new Map(orgTargets.map((item) => [item.id, item])),
    accountById: new Map(accountTargets.map((item) => [item.id, item])),
    orgByCode: new Map(orgTargets.map((item) => [item.code, item])),
    accountByCode: new Map(accountTargets.map((item) => [item.code, item])),
  };
}

interface AliasRow { mapping_kind: 'org' | 'account'; source_text: string; target_code: string }

export function loadAliasMaps(db: DB, targetKind: CleaningTargetKind): { org: Map<string, string>; account: Map<string, string> } {
  const rows = db.prepare(
    'SELECT mapping_kind, source_text, target_code FROM import_name_alias WHERE target_kind = ? ORDER BY id',
  ).all(targetKind) as AliasRow[];
  const result = { org: new Map<string, string>(), account: new Map<string, string>() };
  for (const row of rows) result[row.mapping_kind].set(normalizeSourceText(row.source_text), row.target_code);
  return result;
}

export function manualMappingMaps(mappings: CleaningNameMapping[]): { org: Map<string, string>; account: Map<string, string> } {
  const result = { org: new Map<string, string>(), account: new Map<string, string>() };
  for (const mapping of mappings) result[mapping.kind].set(normalizeSourceText(mapping.sourceText), mapping.targetCode);
  return result;
}

// 打分器与财务映射候选建议共用(core/text-similarity.ts);
// normalizeSourceText 与 normalizeMatchText 实现一致,这里沿用清洗侧既有归一化入口。
function similarity(source: string, target: SimilarityTarget): number {
  return fuzzySimilarity(source, target);
}

function candidates(sourceText: string, targets: MatchingTarget[]): MatchCandidate[] {
  const source = normalizeSourceText(sourceText);
  if (!source) return [];
  return targets.map((target) => ({ ...target, score: Number(similarity(source, target).toFixed(4)) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.code.localeCompare(b.code))
    .slice(0, 8)
    .map(({ id, code, name, path, status, score }) => ({ id, code, name, path, status, score }));
}

function codeMatch(targets: MatchingTarget[], byCode: Map<string, MatchingTarget>, code: string): MatchingTarget | undefined {
  const trimmed = code.trim();
  const exact = byCode.get(trimmed);
  if (exact) return exact;
  const normalized = trimmed.toLocaleLowerCase('en-US');
  const foldedMatches = targets.filter((target) => target.code.toLocaleLowerCase('en-US') === normalized);
  // 主数据编码唯一性是大小写敏感的。只有折叠大小写后仍唯一时才能安全降级匹配；
  // 否则留给人工映射，绝不能按节点顺序静默选中第一个。
  return foldedMatches.length === 1 ? foldedMatches[0] : undefined;
}

export function matchEntity(
  kind: 'org' | 'account',
  input: { codeText: string; nameText: string },
  context: MatchingContext,
  manual: { org: Map<string, string>; account: Map<string, string> },
  aliases: { org: Map<string, string>; account: Map<string, string> },
): EntityMatch {
  const targets = kind === 'org' ? context.orgTargets : context.accountTargets;
  const byCode = kind === 'org' ? context.orgByCode : context.accountByCode;
  const sourceTexts = [input.codeText, input.nameText].map((item) => item.trim()).filter(Boolean);
  const sourceText = input.nameText.trim() || input.codeText.trim();
  const codeTarget = input.codeText.trim() ? codeMatch(targets, byCode, input.codeText) : undefined;
  const normalizedName = normalizeSourceText(input.nameText);
  const nameMatches = normalizedName ? targets.filter((target) => normalizeSourceText(target.name) === normalizedName) : [];
  if (codeTarget && nameMatches.length === 1 && nameMatches[0].id !== codeTarget.id) {
    return { sourceText, candidates: candidates(sourceText, targets), conflictingExactTargets: `${codeTarget.code} / ${nameMatches[0].code}` };
  }
  if (codeTarget) return { sourceText, target: codeTarget, method: 'code', candidates: [] };

  for (const text of sourceTexts) {
    const targetCode = manual[kind].get(normalizeSourceText(text));
    if (targetCode) {
      const target = byCode.get(targetCode);
      if (!target) return { sourceText, candidates: candidates(sourceText, targets), invalidManualTarget: targetCode };
      return { sourceText, target, method: 'manual', candidates: [] };
    }
  }
  for (const text of sourceTexts) {
    const targetCode = aliases[kind].get(normalizeSourceText(text));
    if (targetCode) {
      const target = byCode.get(targetCode);
      if (!target) return { sourceText, candidates: candidates(sourceText, targets), staleAliasTarget: targetCode };
      return { sourceText, target, method: 'alias', candidates: [] };
    }
  }
  if (nameMatches.length === 1) return { sourceText, target: nameMatches[0], method: 'name', candidates: [] };
  return { sourceText, candidates: candidates(sourceText, targets) };
}
