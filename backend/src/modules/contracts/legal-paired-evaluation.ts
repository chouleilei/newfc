/** AC-CLR-09：只对显式提供的历史配对标注计算指标，合成夹具不能提升业务验收状态。 */
import { z } from 'zod';
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const PAIRED_CATEGORIES = ['goods_procurement','construction','small_construction','tech_service','general_service','operations_maintenance','income_sales','important_special'] as const;
const findingKey = z.string().regex(/^[A-Za-z0-9_:-]{1,128}$/).optional();
const annotation = z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]+$/), findingKey, expected: z.boolean(), adoption: z.enum(['accepted','partially_accepted','rejected','unreviewed']) });
const run = z.object({ documentSha256: sha, findings: z.array(z.object({ code: z.string().min(1), findingKey })).max(1000) });
const version = z.object({ run, annotationsComplete: z.boolean(), annotations: z.array(annotation).min(1).max(1000) });
export const pairedEvaluationManifest = z.object({ schemaVersion: z.literal(1), pairs: z.array(z.object({
  caseId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), category: z.enum(PAIRED_CATEGORIES),
  sampleKind: z.enum(['reviewed_history','synthetic']), officialOpinionSha256: sha.nullable(),
  businessReviewConfirmed: z.boolean(), original: version, revised: version,
})).min(1).max(500) });

export function evaluateLegalPairs(raw: unknown) {
  const manifest = pairedEvaluationManifest.parse(raw);
  const ids = new Set<string>(); const seenDocuments = new Set<string>(); const covered = new Set<string>();
  const rows = manifest.pairs.map((pair) => {
    if (ids.has(pair.caseId)) throw new Error('配对样本编号重复'); ids.add(pair.caseId);
    if (pair.original.run.documentSha256 === pair.revised.run.documentSha256) throw new Error('原稿与修订稿不能为同一文档');
    for (const doc of [pair.original, pair.revised]) {
      if (seenDocuments.has(doc.run.documentSha256)) throw new Error('同一文档不能重复计为多个配对样本');
      seenDocuments.add(doc.run.documentSha256);
    }
    let tp = 0, fp = 0, fn = 0, unlabelled = 0, ambiguousFindings = 0, reviewedSuggestions = 0, adoptedSuggestions = 0, unreviewedSuggestions = 0;
    for (const doc of [pair.original, pair.revised]) {
      const hits = new Set(doc.run.findings.map((f) => `${f.code}:${f.findingKey ?? ''}`)); const labels = new Map<string, boolean>();
      ambiguousFindings += doc.run.findings.length - hits.size;
      for (const a of doc.annotations) {
        const key = `${a.code}:${a.findingKey ?? ''}`;
        if (labels.has(key)) throw new Error('同一版本的规则标注重复'); labels.set(key, a.expected);
        if (a.expected && hits.has(key)) tp++; else if (a.expected) fn++; else if (hits.has(key)) fp++;
        if (hits.has(key)) {
          if (a.adoption === 'unreviewed') unreviewedSuggestions++;
          else { reviewedSuggestions++; if (a.adoption === 'accepted' || a.adoption === 'partially_accepted') adoptedSuggestions++; }
        }
      }
      unlabelled += [...hits].filter((code) => !labels.has(code)).length;
    }
    const evidenceComplete = pair.sampleKind === 'reviewed_history' && pair.officialOpinionSha256 !== null && pair.businessReviewConfirmed &&
      pair.original.annotationsComplete && pair.revised.annotationsComplete && pair.original.annotations.some((a) => a.expected) &&
      unlabelled === 0 && ambiguousFindings === 0 && unreviewedSuggestions === 0;
    if (evidenceComplete) covered.add(pair.category);
    return { caseId: pair.caseId, category: pair.category, sampleKind: pair.sampleKind, originalSha256: pair.original.run.documentSha256,
      revisedSha256: pair.revised.run.documentSha256, officialOpinionSha256: pair.officialOpinionSha256, evidenceComplete,
      tp, fp, fn, unlabelled, ambiguousFindings, reviewedSuggestions, adoptedSuggestions, unreviewedSuggestions };
  });
  const missingCategories = PAIRED_CATEGORIES.filter((c) => !covered.has(c));
  return { schemaVersion: 1, evidenceComplete: missingCategories.length === 0, redlineRecallPassed: rows.every((r) => r.fn === 0), missingCategories, rows,
    note: '同一规则的多处发现须使用独立 findingKey 逐项标注；业务验收须核实正式意见与人工采纳评价，合成回归不计历史覆盖。' };
}
