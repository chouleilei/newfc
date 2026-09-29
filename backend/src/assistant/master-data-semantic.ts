/**
 * 主数据「语义命名相似」建议(AI 功能增强计划 §四.阶段三.AI 部分)。
 *
 * 只兜字面距离失效的残差:字面相似度高(含归一化等价)的节点对已被
 * 确定性检查(DUPLICATE_NAME/NAME_FORMAT)覆盖或可由编辑距离发现,
 * 模型只负责「字面距离远但可能同义」的候选对。
 *
 * 硬约束:
 * - 输入仅为名称清单(编码+名称),不涉金额、数量、状态;
 * - 输出经白名单校验:编码必须存在于输入清单,≤20 对,理由截断;
 * - 结果永远标记为建议(source:'model'),不作为事实,不产生任何写入;
 * - 模型未配置/开关关闭/调用失败 -> semanticAvailable=false,pairs=[],
 *   体检报告其余部分完整可用;
 * - 同步/事务路径零模型调用(仅独立 POST 端点触发)。
 */
import type { DB } from '../db/connection';
import { listOrgRows } from '../modules/org/org.service';
import { listAccountRows } from '../modules/account/account.service';
import { normalizeMatchText } from '../core/text-similarity';
import { EnvChatModel, modelConfigured } from './model';
import { masterDataAiEnabled } from './feature-flags';
import { PROMPT_VERSION, masterDataSemanticPrompt } from './prompts';

const MAX_INPUT_NAMES = 300;
const MAX_PAIRS = 20;

export interface SemanticNamePair {
  kind: 'org' | 'account';
  aCode: string;
  aName: string;
  bCode: string;
  bName: string;
  reason: string;
}

export interface SemanticNameReport {
  semanticAvailable: boolean;
  /** 未配置/失败时的确定性原因说明(如「未配置模型」),前端照此展示。 */
  note: string;
  pairs: SemanticNamePair[];
  /** 结果来源:模型建议,永不作为事实。 */
  source: 'model';
  model: string;
  promptVersion: string;
}

interface NameEntry {
  kind: 'org' | 'account';
  code: string;
  name: string;
}

function collectNames(db: DB): NameEntry[] {
  const entries: NameEntry[] = [];
  for (const row of listOrgRows(db)) entries.push({ kind: 'org', code: row.code, name: row.name });
  for (const row of listAccountRows(db)) entries.push({ kind: 'account', code: row.code, name: row.name });
  return entries.slice(0, MAX_INPUT_NAMES);
}

/** 字面近似(归一化等价)的对不需要模型:确定性侧已能发现,这里预先排除。 */
function literalEquivalentGroups(entries: NameEntry[]): Set<string> {
  const groups = new Map<string, string[]>();
  for (const entry of entries) {
    const key = normalizeMatchText(entry.name);
    const list = groups.get(key) ?? [];
    list.push(entry.code);
    groups.set(key, list);
  }
  const equivalent = new Set<string>();
  for (const codes of groups.values()) {
    if (codes.length > 1) for (const code of codes) equivalent.add(code);
  }
  return equivalent;
}

interface AiPairPayload {
  pairs?: { kind?: unknown; a?: unknown; b?: unknown; reason?: unknown }[];
}

/** 白名单校验:kind 合法、编码存在于输入清单、不成环不自指、≤20 对、理由截断。 */
function sanitizePairs(value: unknown, entries: NameEntry[]): SemanticNamePair[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const payload = value as AiPairPayload;
  if (!Array.isArray(payload.pairs)) return [];
  const byCode = new Map(entries.map((entry) => [`${entry.kind}:${normalizeMatchText(entry.code)}`, entry]));
  const seen = new Set<string>();
  const result: SemanticNamePair[] = [];
  for (const item of payload.pairs) {
    if (!item || typeof item !== 'object') continue;
    const kind = item.kind === 'org' ? 'org' : item.kind === 'account' ? 'account' : undefined;
    if (!kind) continue;
    const a = byCode.get(`${kind}:${normalizeMatchText(typeof item.a === 'string' ? item.a : '')}`);
    const b = byCode.get(`${kind}:${normalizeMatchText(typeof item.b === 'string' ? item.b : '')}`);
    if (!a || !b || a.code === b.code) continue;
    const key = [a.code, b.code].sort().join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      kind,
      aCode: a.code,
      aName: a.name,
      bCode: b.code,
      bName: b.name,
      reason: typeof item.reason === 'string' ? item.reason.slice(0, 200) : '',
    });
    if (result.length >= MAX_PAIRS) break;
  }
  return result;
}

/**
 * 语义命名相似建议。任何失败都回退 semanticAvailable=false,不影响体检报告。
 */
export async function masterDataSemanticNames(db: DB): Promise<SemanticNameReport> {
  const base: Omit<SemanticNameReport, 'semanticAvailable' | 'note' | 'pairs'> = {
    source: 'model',
    model: '',
    promptVersion: PROMPT_VERSION.masterDataSemantic,
  };
  if (!masterDataAiEnabled()) {
    return { ...base, semanticAvailable: false, note: '语义命名相似建议已由 BUDGET_MASTER_DATA_AI=0 关闭,体检报告其余部分完整可用', pairs: [] };
  }
  if (!modelConfigured()) {
    return { ...base, semanticAvailable: false, note: '未配置模型,语义命名相似建议不可用;体检报告其余部分完整可用', pairs: [] };
  }
  const entries = collectNames(db);
  if (entries.length < 2) {
    return { ...base, semanticAvailable: false, note: '主数据节点过少,无需语义相似分析', pairs: [] };
  }
  const equivalent = literalEquivalentGroups(entries);
  try {
    const model = new EnvChatModel('master_data_semantic');
    const result = await model.complete({
      messages: [
        {
          role: 'system',
          content: masterDataSemanticPrompt(MAX_PAIRS),
        },
        {
          role: 'user',
          content: JSON.stringify({ names: entries }),
        },
      ],
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      return { ...base, semanticAvailable: false, note: '模型输出不是合法 JSON,已回退为仅确定性体检结果', pairs: [] };
    }
    // 排除字面等价对(确定性侧职责),只保留语义残差
    const pairs = sanitizePairs(parsed, entries).filter((pair) => !(equivalent.has(pair.aCode) && equivalent.has(pair.bCode) && normalizeMatchText(pair.aName) === normalizeMatchText(pair.bName)));
    return {
      ...base,
      model: result.model ?? '',
      semanticAvailable: true,
      note: pairs.length > 0 ? `模型产出 ${pairs.length} 对语义相似候选,仅供参考,请在主数据页人工核实` : '模型未发现语义相似的重名候选',
      pairs,
    };
  } catch {
    return { ...base, semanticAvailable: false, note: '模型调用失败,已回退为仅确定性体检结果', pairs: [] };
  }
}
