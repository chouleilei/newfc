import { describe, expect, it } from 'vitest';
import { evaluateLegalPairs, PAIRED_CATEGORIES } from '../src/modules/contracts/legal-paired-evaluation';
const hash = (n: number) => n.toString(16).padStart(64,'0');
function manifest() { return { schemaVersion: 1, pairs: PAIRED_CATEGORIES.map((category,i) => ({
  caseId: `pair-${i}`, category, sampleKind: 'reviewed_history', officialOpinionSha256: hash(100+i), businessReviewConfirmed: true,
  original: { run: { documentSha256: hash(2*i+1), findings: [{ code: 'RED_LINE' }] }, annotationsComplete: true, annotations: [{ code: 'RED_LINE', expected: true, adoption: 'accepted' }] },
  revised: { run: { documentSha256: hash(2*i+2), findings: [] as { code: string }[] }, annotationsComplete: true, annotations: [{ code: 'RED_LINE', expected: false, adoption: 'accepted' }] },
})) }; }
describe('AC-CLR-09 证据门禁', () => {
  it('八类真实意见配对及人工评价齐备才能标为证据完整，统计漏检/误报/采纳', () => {
    const input = manifest(); expect(evaluateLegalPairs(input)).toMatchObject({ evidenceComplete: true, redlineRecallPassed: true });
    input.pairs[0].original.run.findings = [];
    input.pairs[1].revised.run.findings = [{ code: 'RED_LINE' }];
    const out = evaluateLegalPairs(input); expect(out.redlineRecallPassed).toBe(false); expect(out.rows[0].fn).toBe(1); expect(out.rows[1].fp).toBe(1);
  });
  it('合成样本、未标注发现、缺正式意见或未评价建议均不能算完成历史验收', () => {
    const input = manifest(); input.pairs.forEach((p) => p.sampleKind = 'synthetic');
    expect(evaluateLegalPairs(input).missingCategories).toHaveLength(8);
    const pending = manifest(); pending.pairs[0].original.annotations[0].adoption = 'unreviewed'; pending.pairs[1].original.run.findings.push({ code: 'UNLABELLED' });
    expect(evaluateLegalPairs(pending).evidenceComplete).toBe(false);
  });
  it('相同文档与重复类别借用不能凑足八类证据', () => {
    const input = manifest(); input.pairs[1].original.run.documentSha256 = input.pairs[0].original.run.documentSha256;
    expect(() => evaluateLegalPairs(input)).toThrow(/同一文档/);
  });
  it('同码多处发现不能折叠成一次命中后宣称逐项验收完整', () => {
    const input = manifest(); input.pairs[0].original.run.findings.push({ code: 'RED_LINE' });
    const result = evaluateLegalPairs(input); expect(result.evidenceComplete).toBe(false); expect(result.rows[0].ambiguousFindings).toBe(1);
  });
});
