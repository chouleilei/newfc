/**
 * 财务映射「候选建议」(AI 功能增强计划阶段二)。
 *
 * 确定性先行:与清洗共用的 Levenshtein + 包含加权打分器(core/text-similarity)
 * 对未映射的源编码/名称在映射版本绑定的树快照叶子字典上全量打分,产出 top-N 候选;
 * 匹配前对源串与字典串两侧做 NFKC/trim/大小写归一化(仅建议侧,
 * matcher.ts 的运行时严格全等匹配语义不变)。
 *
 * AI 只兜字面距离失效的残差:确定性候选为空或低置信(top < 0.6)时才调用模型,
 * 输入为源串 + 全量字典(组织/科目字典规模小,可全量;超限先按确定性分截断),
 * 输出经白名单校验(编码必须存在于字典);AI 候选同样进「未复核」状态,
 * 不存在任何模型直写路径。
 */
import type { DB } from '../../../db/connection';
import { Errors } from '../../../core/errors';
import { computeLeafIds, pathOf } from '../../../core/tree';
import { normalizeMatchText, fuzzySimilarity } from '../../../core/text-similarity';
import { loadSnapshotNodes } from '../../tree/snapshot';
import { EnvChatModel, modelConfigured } from '../../../assistant/model';
import { financeMappingAiEnabled } from '../../../assistant/feature-flags';
import { financeMappingResidualPrompt } from '../../../assistant/prompts';
import { getMappingVersion } from './mapping.service';
import { matchOrg, matchAccounts } from './matcher';
import type { NormalizedFinanceRow } from '../finance.types';

export interface MappingCandidateInput {
  kind: 'org' | 'account';
  sourceCode?: string;
  sourceName?: string;
  sourceBookCode?: string;
}

export interface MappingCandidate {
  targetId: number;
  code: string;
  name: string;
  path: string;
  /** 科目类型(仅 kind=account 时有值),供前端给采纳行默认金额规则。 */
  type?: string;
  /** 0-1;别名 0.99,确定性为相似度得分,AI 残差固定 0.5(排在确定性之后)。 */
  score: number;
  source: 'alias' | 'deterministic' | 'ai';
  reason?: string;
}

export interface MappingCandidateResult {
  input: MappingCandidateInput;
  /** 归一化后与字典编码完全一致(确定性,可直接采用)。 */
  exactCodeMatched: boolean;
  /** 确定性候选最高分,低于 AI_RESIDUAL_THRESHOLD 才允许模型残差兜底。 */
  deterministicTopScore: number;
  candidates: MappingCandidate[];
  aiUsed: boolean;
}

/** 确定性 top 低于该分数才允许模型残差兜底。 */
export const AI_RESIDUAL_THRESHOLD = 0.6;
const TOP_N = 8;
/** 送入模型的字典条数上限(超出时按确定性分截断)。 */
const AI_DICTIONARY_LIMIT = 800;

interface TargetRow {
  id: number;
  code: string;
  name: string;
  path: string;
  /** 科目类型(income/cost/expense/quantity),供前端给采纳行默认金额规则;组织为 undefined。 */
  type?: string;
}

function loadTargets(db: DB, versionId: number, kind: 'org' | 'account'): TargetRow[] {
  const version = getMappingVersion(db, versionId);
  const snapshotId = kind === 'org' ? version.org_tree_snapshot_id : version.account_tree_snapshot_id;
  const rows = loadSnapshotNodes(db, snapshotId);
  const leaves = computeLeafIds(rows);
  return rows
    .filter((row) => leaves.has(row.id) && row.status === 'active')
    .map((row) => ({ id: row.id, code: row.code, name: row.name, path: pathOf(rows, row.id), type: row.type }));
}

/** 用户确认的语义映射沉淀(target_kind='finance'),建议侧优先于模糊匹配。 */
function loadFinanceAliases(db: DB, kind: 'org' | 'account'): Map<string, string> {
  const rows = db.prepare(
    "SELECT source_text, target_code FROM import_name_alias WHERE target_kind = 'finance' AND mapping_kind = ? ORDER BY id",
  ).all(kind) as { source_text: string; target_code: string }[];
  const result = new Map<string, string>();
  for (const row of rows) result.set(normalizeMatchText(row.source_text), row.target_code);
  return result;
}

/** 确定性候选:精确编码 → 别名 → 模糊 top-N,按 targetId 去重。 */
export function deterministicCandidates(
  db: DB,
  versionId: number,
  input: MappingCandidateInput,
): { exactCodeMatched: boolean; candidates: MappingCandidate[] } {
  const targets = loadTargets(db, versionId, input.kind);
  const sourceName = normalizeMatchText(input.sourceName ?? '');
  const sourceCode = normalizeMatchText(input.sourceCode ?? '');
  const sourceText = sourceName || sourceCode;
  const byCode = new Map(targets.map((target) => [normalizeMatchText(target.code), target]));
  const best = new Map<number, MappingCandidate>();

  // 1. 归一化后编码完全一致
  let exactCodeMatched = false;
  if (sourceCode) {
    const exact = byCode.get(sourceCode);
    if (exact) {
      exactCodeMatched = true;
      best.set(exact.id, { targetId: exact.id, code: exact.code, name: exact.name, path: exact.path, type: exact.type, score: 1, source: 'deterministic', reason: '编码归一化后完全一致' });
    }
  }
  // 2. 别名沉淀(用户历史确认的语义映射)
  const aliases = loadFinanceAliases(db, input.kind);
  for (const text of [sourceName, sourceCode].filter(Boolean)) {
    const targetCode = aliases.get(text);
    if (!targetCode) continue;
    const target = byCode.get(normalizeMatchText(targetCode));
    if (target && !best.has(target.id)) {
      best.set(target.id, { targetId: target.id, code: target.code, name: target.name, path: target.path, type: target.type, score: 0.99, source: 'alias', reason: '历史确认的别名映射' });
    }
  }
  // 3. 模糊候选:全量字典打分取 top-N
  if (sourceText) {
    const scored = targets
      .map((target) => ({ target, score: Number(fuzzySimilarity(sourceText, target).toFixed(4)) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.target.code.localeCompare(b.target.code))
      .slice(0, TOP_N);
    for (const { target, score } of scored) {
      if (best.has(target.id)) continue;
      best.set(target.id, { targetId: target.id, code: target.code, name: target.name, path: target.path, type: target.type, score, source: 'deterministic' });
    }
  }
  const candidates = [...best.values()].sort((a, b) => b.score - a.score || a.code.localeCompare(b.code)).slice(0, TOP_N);
  return { exactCodeMatched, candidates };
}

interface AiCandidatePayload {
  candidates?: { code?: unknown; reason?: unknown }[];
}

/** AI 残差建议:白名单校验——编码必须在字典内、最多 5 条、理由截断。 */
function sanitizeAiCandidates(value: unknown, targets: TargetRow[]): MappingCandidate[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const payload = value as AiCandidatePayload;
  if (!Array.isArray(payload.candidates)) return [];
  const byCode = new Map(targets.map((target) => [normalizeMatchText(target.code), target]));
  const result: MappingCandidate[] = [];
  for (const item of payload.candidates) {
    if (!item || typeof item !== 'object') continue;
    const code = typeof item.code === 'string' ? item.code : '';
    const target = byCode.get(normalizeMatchText(code));
    if (!target) continue;
    if (result.some((existing) => existing.targetId === target.id)) continue;
    const reason = typeof item.reason === 'string' ? item.reason.slice(0, 200) : undefined;
    result.push({ targetId: target.id, code: target.code, name: target.name, path: target.path, type: target.type, score: 0.5, source: 'ai', ...(reason ? { reason } : {}) });
    if (result.length >= MAX_AI_CANDIDATES) break;
  }
  return result;
}

/** AI 残差候选数上限。 */
const MAX_AI_CANDIDATES = 5;

async function aiResidualCandidates(
  targets: TargetRow[],
  input: MappingCandidateInput,
): Promise<MappingCandidate[]> {
  const dictionary = targets.slice(0, AI_DICTIONARY_LIMIT).map((target) => ({ code: target.code, name: target.name, path: target.path }));
  const model = new EnvChatModel('mapping_candidates');
  const result = await model.complete({
    messages: [
      { role: 'system', content: financeMappingResidualPrompt(input.kind, MAX_AI_CANDIDATES) },
      {
        role: 'user',
        content: JSON.stringify({
          source: { code: input.sourceCode ?? '', name: input.sourceName ?? '', book: input.sourceBookCode ?? '' },
          dictionary,
        }),
      },
    ],
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    return [];
  }
  return sanitizeAiCandidates(parsed, targets);
}

/**
 * 单条源的候选建议:确定性候选为先;为空或低置信且开关与模型可用时才调用模型兜残差。
 * 任何失败都回退为「仅确定性候选」,模型不参与写入。
 */
export async function suggestMappingCandidates(
  db: DB,
  versionId: number,
  input: MappingCandidateInput,
  options: { allowAi?: boolean } = {},
): Promise<MappingCandidateResult> {
  const { exactCodeMatched, candidates } = deterministicCandidates(db, versionId, input);
  const deterministicTopScore = candidates[0]?.score ?? 0;
  const wantAi = Boolean(options.allowAi)
    && financeMappingAiEnabled()
    && modelConfigured()
    && deterministicTopScore < AI_RESIDUAL_THRESHOLD
    && Boolean((input.sourceName ?? '').trim() || (input.sourceCode ?? '').trim());
  if (!wantAi) {
    return { input, exactCodeMatched, deterministicTopScore, candidates, aiUsed: false };
  }
  try {
    const targets = loadTargets(db, versionId, input.kind);
    const aiCandidates = await aiResidualCandidates(targets, input);
    const seen = new Set(candidates.map((candidate) => candidate.targetId));
    const merged = [...candidates, ...aiCandidates.filter((candidate) => !seen.has(candidate.targetId))];
    return { input, exactCodeMatched, deterministicTopScore, candidates: merged, aiUsed: aiCandidates.length > 0 };
  } catch {
    // 模型故障不影响确定性候选
    return { input, exactCodeMatched, deterministicTopScore, candidates, aiUsed: false };
  }
}


/* ---------------- 未映射源清单(批量采纳工作流的入口) ---------------- */

export interface UnmappedSourceRow {
  /** 组织行才有账套 */
  sourceBookCode?: string;
  sourceCode: string;
  sourceName: string;
  /** 该源串在转换批次里出现的行数(排序依据:先处理出现最多的) */
  rowCount: number;
  /** 首次出现位置,便于回原件核对 */
  firstSheet: string;
  firstRow: number;
}

export interface UnmappedSourcesResult {
  mappingVersionId: number;
  conversionId: number;
  year: number;
  snapshotDate: string;
  /** 批次里的源末级行数(分母,用于展示覆盖率) */
  sourceRowCount: number;
  org: UnmappedSourceRow[];
  account: UnmappedSourceRow[];
}

/**
 * 列出某个财务转换批次里、在指定映射版本下仍然「未映射」的源组织与源科目。
 *
 * 判定完全复用运行时匹配器 matchOrg / matchAccounts:同一套严格全等 + 优先级语义,
 * 不在这里另写一份判定,否则清单和真实转换会各说各话。多重命中之类的非「未映射」
 * 冲突不进本清单——那属于映射结构问题,由 validateMappingVersion 与转换报告负责。
 *
 * 只读:不写任何表,不触发模型。
 */
export function unmappedSources(db: DB, versionId: number, conversionId: number): UnmappedSourcesResult {
  const version = getMappingVersion(db, versionId);
  const conversion = db.prepare(
    'SELECT id, source_profile_id, year, snapshot_date, normalized_json FROM finance_conversion_batch WHERE id = ?',
  ).get(conversionId) as { id: number; source_profile_id: number; year: number; snapshot_date: string; normalized_json: string } | undefined;
  if (!conversion) throw Errors.notFound('财务转换批次');
  if (conversion.source_profile_id !== version.source_profile_id) {
    throw Errors.validation('转换批次与映射版本不属于同一个财务数据源');
  }
  let rows: NormalizedFinanceRow[] = [];
  try {
    rows = (JSON.parse(conversion.normalized_json || '{}') as { balance?: NormalizedFinanceRow[] }).balance ?? [];
  } catch {
    rows = [];
  }
  const orgRules = db.prepare(
    'SELECT id, source_book_code, source_org_code, source_org_name, source_aux_json, target_org_id, priority FROM finance_org_mapping WHERE mapping_version_id = ? ORDER BY priority DESC, id',
  ).all(versionId) as Parameters<typeof matchOrg>[1];
  const accountRules = db.prepare(
    'SELECT id, source_account_code, source_account_name, source_aux_json, target_account_id, amount_rule, allocation_method, allocation_weight, priority, status FROM finance_account_mapping WHERE mapping_version_id = ? ORDER BY priority DESC, id',
  ).all(versionId) as Parameters<typeof matchAccounts>[1];

  const orgMisses = new Map<string, UnmappedSourceRow>();
  const accountMisses = new Map<string, UnmappedSourceRow>();
  const bump = (store: Map<string, UnmappedSourceRow>, key: string, make: () => UnmappedSourceRow) => {
    const existing = store.get(key);
    if (existing) existing.rowCount += 1;
    else store.set(key, make());
  };
  for (const row of rows) {
    try {
      matchOrg(row, orgRules);
    } catch (error) {
      // 只收「未映射」;多重命中等结构冲突不属于候选建议的职责
      if (error instanceof Error && error.message.includes('组织未映射')) {
        bump(orgMisses, `${row.bookCode}\u0001${row.orgCode}\u0001${row.orgName}`, () => ({
          sourceBookCode: row.bookCode,
          sourceCode: row.orgCode,
          sourceName: row.orgName,
          rowCount: 1,
          firstSheet: row.sourceSheet,
          firstRow: row.sourceRow,
        }));
      }
    }
    try {
      matchAccounts(row, accountRules);
    } catch (error) {
      if (error instanceof Error && error.message.includes('科目未映射')) {
        bump(accountMisses, `${row.accountCode}\u0001${row.accountName}`, () => ({
          sourceCode: row.accountCode,
          sourceName: row.accountName,
          rowCount: 1,
          firstSheet: row.sourceSheet,
          firstRow: row.sourceRow,
        }));
      }
    }
  }
  const sortRows = (store: Map<string, UnmappedSourceRow>) => [...store.values()]
    .sort((a, b) => b.rowCount - a.rowCount || a.sourceCode.localeCompare(b.sourceCode));
  return {
    mappingVersionId: versionId,
    conversionId: conversion.id,
    year: conversion.year,
    snapshotDate: conversion.snapshot_date,
    sourceRowCount: rows.length,
    org: sortRows(orgMisses),
    account: sortRows(accountMisses),
  };
}
