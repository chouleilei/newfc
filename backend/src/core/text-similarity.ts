/**
 * 文本相似度(AI 功能增强计划阶段二.1):Levenshtein + 包含加权,
 * 由清洗匹配(io/cleaning/matching.ts)与财务映射候选建议共用的确定性打分器。
 *
 * 只服务于「建议侧」:运行时严格匹配(matcher.ts 全等匹配、清洗 code 精确匹配)
 * 的语义不受影响。
 */

/**
 * 匹配前归一化:NFKC(全半角统一) + 去首尾空白 + 折叠内部空白 + 小写折叠。
 * 作用于源串与字典串两侧,仅建议侧使用。
 */
export function normalizeMatchText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, '').toLocaleLowerCase('zh-CN');
}

export function levenshteinDistance(a: string, b: string): number {
  if (!a) return b.length;
  if (!b) return a.length;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length];
}

export interface SimilarityTarget {
  code: string;
  name: string;
}

/**
 * 清洗 matching.ts 的打分口径:名称/编码 Levenshtein 相似度 + 包含加权(0.12),封顶 1。
 * source 需先经 normalizeMatchText 归一化。
 */
export function fuzzySimilarity(source: string, target: SimilarityTarget): number {
  const normalizedName = normalizeMatchText(target.name);
  const normalizedCode = normalizeMatchText(target.code);
  const nameScore = 1 - levenshteinDistance(source, normalizedName) / Math.max(source.length, normalizedName.length, 1);
  const codeScore = 1 - levenshteinDistance(source, normalizedCode) / Math.max(source.length, normalizedCode.length, 1);
  const containsBonus = normalizedName.includes(source) || source.includes(normalizedName) ? 0.12 : 0;
  return Math.max(0, Math.min(1, Math.max(nameScore + containsBonus, codeScore)));
}
