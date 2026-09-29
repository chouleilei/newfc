/**
 * 导入辅助(方案《AI助手完整方案》4.1「导入辅助:解释错误、建议组织/科目匹配、
 * 列出未匹配和重复项」)。
 *
 * 全部确定性:错误分类与解释是固化规则,匹配建议来自当前组织树/科目树的编码与
 * 名称相似度(整数编辑距离 + 前缀/包含关系),模型不参与打分,也不会凭空造编码。
 *
 * 输入既支持上传失败时 API 返回的 IMPORT_VALIDATION_FAILED 错误数组,也支持
 * 已持久化的导入批次(读取其 summary/result 中的错误)。
 */
import type { DB } from '../db/connection';
import type { RowError } from '../core/errors';
import { Errors } from '../core/errors';
import * as imports from '../modules/import/import.service';
import { listOrgRows } from '../modules/org/org.service';
import { listAccountRows, getAccountTree } from '../modules/account/account.service';
import { getOrgTree } from '../modules/org/org.service';

export interface ImportHelpInput {
  /** 已持久化的导入批次 */
  batchId?: number | null;
  /** 上传失败时 API 返回的 errors 数组 */
  errors?: unknown;
  /** 每个未匹配编码给出的候选数量,默认 3 */
  suggestionLimit?: number | null;
}

export interface ImportErrorGroup {
  category: string;
  label: string;
  /** 错误含义(固化口径) */
  explanation: string;
  /** 处理建议 */
  fix: string;
  count: number;
  /** 命中的 Excel 行号(0 表示整表级错误),最多 100 个 */
  rows: number[];
  samples: RowError[];
}

export interface ImportMatchCandidate {
  id: number;
  code: string;
  name: string;
  isLeaf: boolean;
  status: string;
  /** 科目维度才有 */
  type?: string;
  /** 0~1,越大越可能是同一个节点 */
  score: number;
  reason: string;
}

export interface ImportMatchSuggestion {
  kind: 'org' | 'account';
  /** 文件中未匹配的编码 */
  code: string;
  rows: number[];
  candidates: ImportMatchCandidate[];
}

export interface ImportDuplicateRow {
  row: number;
  field: string;
  message: string;
  /** 从「与第 N 行重复」中解析出的首次出现行 */
  firstRow: number | null;
}

export interface ImportHelpReport {
  batch: {
    id: number;
    kind: string;
    status: string;
    originalName: string;
    history: boolean;
    targetVersionId: number | null;
    createdAt: string;
    committedAt: string | null;
    rolledBackAt: string | null;
    summary: unknown;
    result: unknown;
  } | null;
  errorCount: number;
  groups: ImportErrorGroup[];
  unmatched: { org: ImportMatchSuggestion[]; account: ImportMatchSuggestion[] };
  duplicates: ImportDuplicateRow[];
  nextSteps: string[];
  notes: string[];
}

interface CategoryRule {
  category: string;
  label: string;
  explanation: string;
  fix: string;
  test: (error: RowError) => boolean;
}

const RULES: CategoryRule[] = [
  {
    category: 'ORG_CODE_UNKNOWN',
    label: '组织编码不存在',
    explanation: '文件中的组织编码在当前组织树里找不到。组织编码创建后不可变更,拼写差一位就无法匹配。',
    fix: '核对下方候选组织并改用正确编码;确属新组织时先在「组织管理」中建立,再重新导入。',
    test: (e) => /组织编码不存在/.test(e.message),
  },
  {
    category: 'ACCOUNT_CODE_UNKNOWN',
    label: '科目编码不存在',
    explanation: '文件中的科目编码在当前科目树里找不到,可能是手误或该科目已被删除。',
    fix: '核对下方候选科目并改用正确编码;确属新科目时先在「科目管理」中建立,再重新导入。',
    test: (e) => /科目编码不存在/.test(e.message),
  },
  {
    category: 'ORG_NOT_LEAF',
    label: '组织不是叶子节点',
    explanation: '只有叶子组织可以填报数据,上级组织的数值由系统按组织树汇总得出。',
    fix: '把金额拆到该组织下的各个叶子组织分别填报,不要在汇总组织上直接填数。',
    test: (e) => /不是叶子组织/.test(e.message),
  },
  {
    category: 'ACCOUNT_NOT_LEAF',
    label: '科目不是末级节点',
    explanation: '只有末级科目可以填报数据,汇总科目的数值由系统按科目树汇总得出。',
    fix: '把金额拆到该科目下的各个末级科目分别填报。',
    test: (e) => /不是末级科目|不是叶子科目/.test(e.message),
  },
  {
    category: 'DUPLICATE_ROW',
    label: '重复行',
    explanation: '同一组合(年度 + 截止日期 + 组织 + 科目)在文件中出现了多次,系统无法判断应采用哪一行。',
    fix: '合并重复行后只保留一行;若确实需要分笔记录,请在填报前自行合计。',
    test: (e) => /重复/.test(e.message),
  },
  {
    category: 'AMOUNT_FORMAT',
    label: '金额格式不正确',
    explanation: '金额必须是十进制数字。界面与模板口径为万元两位小数(对应百元精度);允许负数表示冲减或冲回。',
    fix: '去掉千分位、货币符号与单位文字,保留两位小数后重新填写。',
    test: (e) => /金额格式不正确/.test(e.message),
  },
  {
    category: 'QUANTITY_FORMAT',
    label: '数量格式不正确',
    explanation: '数量型科目最多四位小数,按 10^4 缩放为整数存储,与金额完全隔离。',
    fix: '把数量改为最多四位小数的数字;不要在数量列填金额。',
    test: (e) => /数量格式不正确/.test(e.message),
  },
  {
    category: 'AMOUNT_OR_QUANTITY_REQUIRED',
    label: '金额与数量都为空',
    explanation: '金额科目填金额、数量科目填数量,两者至少要有一个有值,否则该行没有可导入的内容。',
    fix: '补齐对应列的数值,或删除该空行。',
    test: (e) => /至少填一项/.test(e.message),
  },
  {
    category: 'REQUIRED_MISSING',
    label: '必填项为空',
    explanation: '年度、截止日期、组织编码、科目编码是定位一条数据的必要条件,缺一不可。',
    fix: '补齐提示的字段后重新导入。',
    test: (e) => /不能为空/.test(e.message),
  },
  {
    category: 'DATE_FORMAT',
    label: '日期格式或与年度不一致',
    explanation: '截止日期必须是 YYYY-MM-DD,并且要落在所填年度内;截止日期决定这批数据属于哪个快照时点。',
    fix: '把日期改成 YYYY-MM-DD 形式,并确认与年度列一致。',
    test: (e) => /截止日期/.test(e.message) && !/不能为空|不能早于/.test(e.message),
  },
  {
    category: 'DATE_ORDER',
    label: '截止日期早于现有最新时点',
    explanation: '当前实际数只能向前推进。要补更早时点的数据,应走「历史补录」,它只追加历史快照而不覆盖当前实际。',
    fix: '改用历史补录导入,或把截止日期改为不早于现有最新时点。',
    test: (e) => /不能早于/.test(e.message),
  },
  {
    category: 'YEAR_FROZEN',
    label: '年度已关闭',
    explanation: '年度关闭后会锁定最终快照,禁止再写入,以保证历年对比口径稳定。',
    fix: '如确需修改,先在「年度关闭」中重开该年度,处理完再重新关闭。',
    test: (e) => /冻结|已关闭/.test(e.message),
  },
  {
    category: 'YEAR_FORMAT',
    label: '年度格式不正确',
    explanation: '年度必须是四位数字。',
    fix: '把年度列改为四位数字年份。',
    test: (e) => /年度格式|年度不能为空/.test(e.message) || (e.field === '年度' && /不正确/.test(e.message)),
  },
  {
    category: 'SCOPE_MISMATCH',
    label: '科目不适用于该组织',
    explanation: '科目按组织范围区分适用性,超出范围的组合不允许填报。',
    fix: '确认该组织应填报的科目范围,删除不适用的组合。',
    test: (e) => /不适用于该组织|不属于/.test(e.message),
  },
  {
    category: 'HEADER_UNRECOGNIZED',
    label: '表头未能识别',
    explanation: '结构化模板依赖固定表头定位年度、截止日期和组织编码;表头被改动后无法解析。',
    fix: '重新下载模板,不要改动表头行与工作表命名规则。',
    test: (e) => /未能识别/.test(e.message),
  },
  {
    category: 'FILE_LEVEL',
    label: '整表级问题',
    explanation: '文件没有数据行,或超过单文件行数上限。',
    fix: '确认数据写在模板要求的工作表与列上;超限时拆分为多个文件分批导入。',
    test: (e) => e.row === 0 || /没有数据行|没有检测到|不超过/.test(e.message),
  },
];

const FALLBACK_RULE: CategoryRule = {
  category: 'OTHER',
  label: '其他校验错误',
  explanation: '该错误不属于已固化的分类,请按提示逐行核对。',
  fix: '按错误消息修改对应单元格后重新导入。',
  test: () => true,
};

function toRowErrors(value: unknown): RowError[] {
  if (!Array.isArray(value)) return [];
  const out: RowError[] = [];
  for (const item of value.slice(0, 20_000)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const row = Number(raw.row);
    out.push({
      row: Number.isSafeInteger(row) ? row : 0,
      field: raw.field == null ? '' : String(raw.field).slice(0, 100),
      message: raw.message == null ? '' : String(raw.message).slice(0, 1_000),
    });
  }
  return out;
}

/** 编辑距离(Levenshtein),整数动态规划,用于编码/名称相似度打分。 */
function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function similarity(left: string, right: string): number {
  const longest = Math.max(left.length, right.length);
  if (longest === 0) return 0;
  return 1 - editDistance(left, right) / longest;
}

interface CandidateNode {
  id: number;
  code: string;
  name: string;
  status: string;
  isLeaf: boolean;
  type?: string;
}

function scoreCandidates(code: string, nodes: CandidateNode[], limit: number): ImportMatchCandidate[] {
  const target = code.trim();
  return nodes
    .map((node) => {
      const codeScore = similarity(target, node.code);
      const prefix = node.code.startsWith(target) || target.startsWith(node.code);
      const contains = node.code.includes(target) || target.includes(node.code);
      const nameHit = target.length >= 2 && node.name.includes(target);
      // 前缀/包含关系是编码体系里最常见的手误来源,给确定性加权后仍夹在 0~1。
      let score = codeScore;
      if (prefix) score = Math.max(score, 0.9);
      else if (contains) score = Math.max(score, 0.8);
      if (nameHit) score = Math.max(score, 0.75);
      if (node.isLeaf) score += 0.02;
      if (node.status !== 'active') score -= 0.05;
      score = Math.max(0, Math.min(1, score));
      const reasons: string[] = [];
      if (prefix) reasons.push('编码前缀一致');
      else if (contains) reasons.push('编码包含关系');
      if (nameHit) reasons.push('名称包含该文本');
      if (!reasons.length) reasons.push(`编码相似度 ${(codeScore * 100).toFixed(0)}%`);
      if (node.isLeaf) reasons.push('可填报的末级节点');
      else reasons.push('汇总节点,不可直接填报');
      if (node.status !== 'active') reasons.push('已停用');
      return {
        id: node.id,
        code: node.code,
        name: node.name,
        isLeaf: node.isLeaf,
        status: node.status,
        ...(node.type == null ? {} : { type: node.type }),
        score: Number(score.toFixed(4)),
        reason: reasons.join(';'),
      };
    })
    .filter((candidate) => candidate.score >= 0.4)
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.code.localeCompare(b.code)))
    .slice(0, limit);
}

function extractCode(message: string): string | null {
  const match = message.match(/不存在[:：]\s*(.+)$/);
  if (!match) return null;
  const code = match[1].trim();
  return code ? code.slice(0, 100) : null;
}

/**
 * 导入辅助报告:错误分类解释 + 未匹配编码的候选建议 + 重复项清单。
 */
export function importHelpReport(db: DB, input: ImportHelpInput): ImportHelpReport {
  const suggestionLimit = (() => {
    if (input.suggestionLimit == null || input.suggestionLimit === ('' as unknown)) return 3;
    const n = Number(input.suggestionLimit);
    if (!Number.isSafeInteger(n) || n < 1 || n > 20) throw Errors.validation('suggestionLimit必须是 1-20 的整数');
    return n;
  })();

  let batch: ImportHelpReport['batch'] = null;
  const errors: RowError[] = toRowErrors(input.errors);
  if (input.batchId != null) {
    const id = Number(input.batchId);
    if (!Number.isSafeInteger(id) || id <= 0) throw Errors.validation('batchId必须是正整数');
    const row = imports.getBatch(db, id) as any;
    const parse = (raw: string | null | undefined): unknown => {
      if (!raw) return {};
      try { return JSON.parse(raw); } catch { return { invalidJson: true }; }
    };
    const summary = parse(row.summary_json);
    const result = parse(row.result_json);
    batch = {
      id: row.id,
      kind: row.kind,
      status: row.status,
      originalName: row.original_name,
      history: row.history === 1,
      targetVersionId: row.target_version_id ?? null,
      createdAt: row.created_at,
      committedAt: row.committed_at ?? null,
      rolledBackAt: row.rolled_back_at ?? null,
      summary,
      result,
    };
    for (const source of [summary, result]) {
      const candidate = (source as Record<string, unknown> | null)?.errors;
      errors.push(...toRowErrors(candidate));
    }
  }
  if (input.batchId == null && !errors.length) throw Errors.validation('请提供 batchId 或 errors 之一');

  // 错误分类
  const grouped = new Map<string, { rule: CategoryRule; items: RowError[] }>();
  for (const error of errors) {
    const rule = RULES.find((candidate) => candidate.test(error)) ?? FALLBACK_RULE;
    const bucket = grouped.get(rule.category);
    if (bucket) bucket.items.push(error);
    else grouped.set(rule.category, { rule, items: [error] });
  }
  const groups: ImportErrorGroup[] = [...grouped.values()]
    .map(({ rule, items }) => ({
      category: rule.category,
      label: rule.label,
      explanation: rule.explanation,
      fix: rule.fix,
      count: items.length,
      rows: [...new Set(items.map((item) => item.row))].sort((a, b) => a - b).slice(0, 100),
      samples: items.slice(0, 5),
    }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.category.localeCompare(b.category)));

  // 未匹配编码的匹配建议
  const orgRows = listOrgRows(db);
  const orgLeafIds = new Set(getOrgTree(db).leafIds);
  const accountRows = listAccountRows(db);
  const accountLeafIds = new Set(getAccountTree(db).leafIds);
  const orgNodes: CandidateNode[] = orgRows.map((row: any) => ({
    id: row.id, code: String(row.code), name: String(row.name), status: String(row.status ?? 'active'), isLeaf: orgLeafIds.has(row.id),
  }));
  const accountNodes: CandidateNode[] = accountRows.map((row: any) => ({
    id: row.id, code: String(row.code), name: String(row.name), status: String(row.status ?? 'active'), isLeaf: accountLeafIds.has(row.id), type: String(row.type ?? ''),
  }));

  const collectUnmatched = (category: string, kind: 'org' | 'account', nodes: CandidateNode[]): ImportMatchSuggestion[] => {
    const byCode = new Map<string, number[]>();
    for (const error of errors) {
      const rule = RULES.find((candidate) => candidate.test(error)) ?? FALLBACK_RULE;
      if (rule.category !== category) continue;
      const code = extractCode(error.message);
      if (!code) continue;
      const rows = byCode.get(code);
      if (rows) rows.push(error.row);
      else byCode.set(code, [error.row]);
    }
    return [...byCode.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(0, 200)
      .map(([code, rows]) => ({
        kind,
        code,
        rows: [...new Set(rows)].sort((a, b) => a - b).slice(0, 100),
        candidates: scoreCandidates(code, nodes, suggestionLimit),
      }));
  };

  const duplicates: ImportDuplicateRow[] = errors
    .filter((error) => /重复/.test(error.message))
    .slice(0, 500)
    .map((error) => {
      const match = error.message.match(/与第\s*(\d+)\s*行重复/);
      return { row: error.row, field: error.field, message: error.message, firstRow: match ? Number(match[1]) : null };
    });

  const unmatched = {
    org: collectUnmatched('ORG_CODE_UNKNOWN', 'org', orgNodes),
    account: collectUnmatched('ACCOUNT_CODE_UNKNOWN', 'account', accountNodes),
  };

  const nextSteps: string[] = [];
  if (unmatched.org.length || unmatched.account.length) {
    nextSteps.push(`先处理 ${unmatched.org.length} 个未匹配组织编码与 ${unmatched.account.length} 个未匹配科目编码,按候选建议逐个确认`);
  }
  if (duplicates.length) nextSteps.push(`合并 ${duplicates.length} 处重复行后重新导入`);
  const formatGroup = groups.find((group) => group.category === 'AMOUNT_FORMAT' || group.category === 'QUANTITY_FORMAT');
  if (formatGroup) nextSteps.push('按万元两位小数(金额)与四位小数(数量)修正格式,去掉千分位与单位文字');
  if (groups.some((group) => group.category === 'DATE_ORDER')) nextSteps.push('更早时点的数据改用「历史补录」导入,不会覆盖当前实际');
  if (groups.some((group) => group.category === 'YEAR_FROZEN')) nextSteps.push('年度已关闭:先重开年度再导入,处理完重新关闭');
  if (!errors.length) nextSteps.push('该批次没有记录校验错误;如需回退已提交批次,请使用数据管理中的安全撤销');
  if (!nextSteps.length) nextSteps.push('按分组解释逐类修正后重新上传预览,确认无误再提交');

  return {
    batch,
    errorCount: errors.length,
    groups,
    unmatched,
    duplicates,
    nextSteps,
    notes: [
      '错误解释与处理建议为后端固化口径,模型不可用时同样可用',
      '匹配建议基于当前组织树/科目树的编码与名称相似度,仅为建议,需人工确认后再改文件',
      '导入只有在预览通过并人工确认后才写入;全部错误行都会阻止本次导入,不存在半成功写入',
      '金额界面口径为万元两位小数(百元精度),数量最多四位小数',
    ],
  };
}
