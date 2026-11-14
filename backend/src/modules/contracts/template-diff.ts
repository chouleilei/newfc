import type {
  TemplateDto,
  LegalFinding,
} from '../../contracts/contract-legal-review';
import type { ParsedDocument } from './document-parser';
const clean = (s: string) =>
  s
    .normalize('NFKC')
    .replace(/^[\d.、\s]+/, '')
    .replace(/[\s\p{P}\p{S}]/gu, '');
export function templateDiff(
  parsed: ParsedDocument,
  template: TemplateDto | null,
): LegalFinding[] {
  if (!template)
    return [
      {
        source: 'template_diff',
        code: 'TEMPLATE_CANDIDATE_UNCONFIRMED',
        severity: 'info',
        blocking: false,
        title: '无唯一适用的正式范本',
        message: '请人工审查条款适用性',
        locationRef: '全文',
        excerpt: '',
        expectedText: '正式核定的适用范本',
        suggestedText: '补充主管部门核定依据',
        policyClauseId: null,
        templateClauseId: null,
      },
    ];
  const out: LegalFinding[] = [];
  const official = template.approvalStatus === 'official';
  if (!official)
    out.push({
      source: 'template_diff',
      code: 'TEMPLATE_CANDIDATE_UNCONFIRMED',
      severity: 'info',
      blocking: false,
      title: '当前比对基准为候选清理稿（待主管部门核定转正）',
      message: template.notes,
      locationRef: '全文',
      excerpt: '',
      expectedText: '主管部门核定固定条款与默认值',
      suggestedText: '人工核验商业条件后填写复核说明',
      policyClauseId: null,
      templateClauseId: null,
    });
  if (!parsed.text) return out;
  for (const c of template.clauses) {
    if (c.tier === 'placeholder') continue;
    const expected = c.standardText.replace(/【默认\s*([^】]+)】/g, '$1');
    if (clean(parsed.text).includes(clean(expected))) continue;
    const inSection = parsed.paragraphs.filter(
      (p) =>
        clean(p.heading) ===
        clean(c.clauseNo.match(/^第.+?条/)?.[0] ?? c.clauseNo),
    );
    const prefix = clean(expected).slice(0, 8);
    const current =
      inSection.find((p) => clean(p.text).includes(prefix)) ??
      parsed.paragraphs.find((p) => clean(p.text).includes(prefix));
    if (c.tier === 'default_ref') {
      const defaults = [
        ...c.standardText.matchAll(
          /【默认\s*([^】]+)】\s*(%|年|个月|日|个工作日|小时)?/g,
        ),
      ].map((m) => `${m[1]}${m[2] ?? ''}`);
      if (
        current &&
        defaults.every((d) => clean(current.text).includes(clean(d)))
      )
        continue;
    }
    out.push({
      source: 'template_diff',
      code:
        c.tier === 'fixed'
          ? 'TEMPLATE_FIXED_DEVIATION'
          : 'TEMPLATE_DEFAULT_CHANGED',
      severity: c.tier === 'fixed' && official ? 'high' : 'medium',
      blocking: official,
      title:
        c.tier === 'fixed'
          ? '固定条款存在删改，需核对实质义务'
          : '范本默认参考值发生变化',
      message: `${c.title}：请对照参考值核对当前条款`,
      locationRef: current
        ? `${current.heading} / P${current.index}`
        : c.clauseNo,
      excerpt: current?.text ?? '',
      expectedText: c.standardText,
      suggestedText: '核对删改理由并补充双方确认的适用条款',
      policyClauseId: c.policyClauseRef ?? null,
      templateClauseId: c.id,
    });
  }
  return out;
}
