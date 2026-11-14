import { z } from 'zod';
import type { DB } from '../../db/connection';
import { currentAuth, type AuthContext } from '../../core/request-context';
import { AppError } from '../../core/errors';
import type {
  LegalFinding,
  LegalRunDto,
  LegalReviewsDto,
  PolicyDto,
  TemplateDto,
  Verdict,
} from '../../contracts/contract-legal-review';
import {
  EnvChatModel,
  modelConfigured,
  type ChatModel,
} from '../../assistant/model';
import { contractLegalPrompt } from '../../assistant/prompts';
import type { ObjectStore } from '../files/object-store';
import { submitJob, type JobHandle } from '../jobs/job.service';
import { loadAuthContext } from '../security/security.service';
import { legalAccess } from './legal-access';
import { legalSnapshot } from './legal-context';
import { legalRunCurrent } from './legal-review-gate';
import { readPolicies, selectLegalTemplate } from './legal-catalog.service';
import {
  parseContractDocument,
  parserFinding,
  type ParsedDocument,
} from './document-parser';
import { legalRules, norm } from './legal-rules';
import { getAllowedNewContractPrefixes } from './prefix-map.service';
import { templateDiff } from './template-diff';
import { recordEvent } from './contract.service';
const requiredPolicies = ['L-QJ03-04-2026', 'L-QJ02-04-2026', 'XLZ-2025-03'];
function catalog(db: DB, category: string) {
  const ps = readPolicies(db).filter(
    (p) =>
      p.status === 'active' &&
      p.effectiveFrom <= new Date().toISOString().slice(0, 10),
  );
  const policies = ps.filter(
    (p) => !ps.some((q) => q.code === p.code && q.version > p.version),
  );
  return { policies, template: selectLegalTemplate(db, category) };
}
export function modelExcerpt(
  parsed: ParsedDocument,
  budget = 24000,
  differences: LegalFinding[] = [],
) {
  const core =
    /甲方|乙方|价|款|工期|交付|验收|质保|保修|违约|解除|争议|仲裁|诉讼|分包|生效|保密|知识产权|责任|合同专用/;
  const changed = parsed.paragraphs.filter((p) =>
    differences.some(
      (f) => f.excerpt && norm(p.text).includes(norm(f.excerpt)),
    ),
  );
  const prioritized = [
    ...new Set([
      ...changed,
      ...parsed.paragraphs.filter((p) => core.test(p.text)),
      ...parsed.paragraphs,
    ]),
  ];
  let text = '',
    coreClausesTruncated = false;
  for (const p of prioritized) {
    const entry = `[P${p.index} / 第${p.page}页 / ${p.heading}] ${p.text}\n`;
    if (text.length + entry.length > budget) {
      if (core.test(p.text)) coreClausesTruncated = true;
      continue;
    }
    text += entry;
  }
  return {
    text,
    stats: {
      originalCharacters: parsed.text.length,
      modelCharacters: text.length,
      coreClausesTruncated,
      fullTextTruncated: text.length < parsed.text.length,
    },
  };
}
const findingSchema = z
  .object({
    code: z.string().min(1).max(80),
    severity: z.enum(['high', 'medium', 'low', 'info']),
    title: z.string().min(1).max(200),
    message: z.string().min(1).max(2000),
    locationRef: z.string().min(1).max(200),
    excerpt: z.string().min(1).max(3000),
    policyClauseId: z.number().int().positive().nullable(),
    templateClauseId: z.number().int().positive().nullable(),
    suggestedText: z.string().max(3000),
  })
  .strict();
const semanticSchema = z
  .object({ findings: z.array(findingSchema).max(40) })
  .strict();
export async function semanticReview(
  parsed: ParsedDocument,
  policies: PolicyDto[],
  template: TemplateDto | null,
  model?: ChatModel,
  differences: LegalFinding[] = [],
  context: Record<string, string> = {},
) {
  const input = modelExcerpt(parsed, 24000, differences);
  const findings: LegalFinding[] = [];
  let status: LegalRunDto['modelStatus'] = 'skipped';
  let modelName = 'unavailable';
  if (input.stats.coreClausesTruncated)
    findings.push(
      parserFinding(
        'MODEL_INPUT_TRUNCATED',
        '核心商务或红线条款超出模型预算，请人工核对',
      ),
    );
  if (!parsed.text) return { status, findings, stats: input.stats };
  if (!model && !modelConfigured('contract_legal_review'))
    return {
      status: 'unavailable',
      findings: [
        ...findings,
        parserFinding('MODEL_UNAVAILABLE', '语义审查模型未配置，需人工审查'),
      ],
      stats: input.stats,
    };
  const clauses = policies.flatMap((p) => p.clauses);
  const tcs = template?.clauses ?? [];
  try {
    const payload = {
      context,
      policies: clauses.map((c) => ({ id: c.id, text: c.clauseText })),
      template: tcs.map((c) => ({
        id: c.id,
        tier: c.tier,
        text: c.standardText,
      })),
      contract: `<untrusted_contract_text>\n${input.text}\n</untrusted_contract_text>`,
    };
    const response = await (
      model ?? new EnvChatModel('contract_legal_review')
    ).complete({
      messages: [
        { role: 'system', content: contractLegalPrompt() },
        { role: 'user', content: JSON.stringify(payload) },
      ],
    });
    modelName = response.model ?? 'custom-model';
    const data = semanticSchema.parse(
      JSON.parse(response.text.replace(/^```(?:json)?\s*|\s*```$/g, '')),
    );
    for (const f of data.findings) {
      const paragraph = parsed.paragraphs.find((p) =>
        norm(p.text).includes(norm(f.excerpt)),
      );
      const numeric = [
        ...(f.title + ' ' + f.message + ' ' + f.suggestedText).matchAll(
          /\d+(?:\.\d+)?/g,
        ),
      ].map((m) => m[0]);
      const evidenceText = [
        f.excerpt,
        clauses.find((c) => c.id === f.policyClauseId)?.clauseText ?? '',
        tcs.find((c) => c.id === f.templateClauseId)?.standardText ?? '',
      ].join(' ');
      const evidenceNumbers = new Set(
        [...evidenceText.normalize('NFKC').matchAll(/\d+(?:\.\d+)?/g)].map(
          (m) => m[0],
        ),
      );
      if (
        !paragraph ||
        !norm(input.text).includes(norm(f.excerpt)) ||
        (!f.policyClauseId && !f.templateClauseId) ||
        (f.policyClauseId && !clauses.some((c) => c.id === f.policyClauseId)) ||
        (f.templateClauseId && !tcs.some((c) => c.id === f.templateClauseId)) ||
        numeric.some((n) => !evidenceNumbers.has(n))
      )
        throw new Error('MODEL_EVIDENCE_UNVERIFIED');
      findings.push({
        ...f,
        source: 'model',
        blocking: f.severity === 'high' || f.severity === 'medium',
        locationRef: `${paragraph.heading} / P${paragraph.index} / 第${paragraph.page}页`,
        expectedText:
          clauses.find((c) => c.id === f.policyClauseId)?.clauseText ??
          tcs.find((c) => c.id === f.templateClauseId)?.standardText ??
          '',
      });
    }
    status = 'ok';
  } catch (e) {
    status =
      e instanceof Error &&
      (e.message === 'MODEL_EVIDENCE_UNVERIFIED' ||
        e instanceof z.ZodError ||
        e instanceof SyntaxError)
        ? 'invalid'
        : 'failed';
    findings.splice(
      0,
      findings.length,
      ...findings.filter((f) => f.source !== 'model'),
      parserFinding(
        status === 'invalid' ? 'MODEL_EVIDENCE_UNVERIFIED' : 'MODEL_FAILED',
        '模型输出无法验证或调用失败，需人工审查',
      ),
    );
  }
  return { status, findings, stats: { ...input.stats, modelName } };
}
export function verdictFor(
  findings: LegalFinding[],
  parseStatus: string,
  modelStatus: string,
  official: boolean,
  policiesComplete: boolean,
): Verdict {
  if (parseStatus !== 'ok' || !['ok', 'skipped'].includes(modelStatus))
    return 'manual_review';
  if (findings.some((f) => f.blocking)) return 'revise';
  if (
    parseStatus !== 'ok' ||
    modelStatus !== 'ok' ||
    !official ||
    !policiesComplete ||
    findings.some(
      (f) =>
        f.severity === 'high' ||
        [
          'PAYMENT_SCHEDULE_UNVERIFIED',
          'AMOUNT_UNPARSEABLE',
          'VARIABLE_PRICE_REQUIRES_CHECK',
          'AMOUNT_UPPER_LOWER_MISMATCH',
          'MODEL_INPUT_TRUNCATED',
          'DOCX_AUXILIARY_CONTENT',
          'DOCX_COMPLEX_CONTENT',
          'IMPORTANT_CONTRACT_MANUAL',
        ].includes(f.code),
    )
  )
    return 'manual_review';
  return 'pass';
}
async function runReview(
  db: DB,
  store: ObjectStore,
  id: number,
  expectedFingerprint: string,
  handle: JobHandle,
  model?: ChatModel,
) {
  legalAccess(currentAuth(), ['contract:write', 'contract:review']);
  const snap = legalSnapshot(db, id);
  if (snap.fingerprint !== expectedFingerprint || !snap.doc)
    throw new AppError(
      'LEGAL_REVIEW_STALE',
      '正文或合同要素已变化，请重新运行',
      409,
    );
  handle.checkCancelled();
  handle.progress(100, '解析合同正文');
  const parsed = await parseContractDocument(
    db,
    store.read(snap.doc.sha256),
    snap.doc.original_name,
    snap.doc.sha256,
  );
  const { policies, template } = catalog(db, snap.c.legal_category);
  const orgRow = db
    .prepare('SELECT name, is_direct_station FROM org WHERE id=?')
    .get(snap.c.org_id) as { name: string; is_direct_station: number };
  const org = orgRow.name;
  const supplier = snap.c.supplier_id
    ? ((
        db
          .prepare('SELECT name FROM md_supplier WHERE id=?')
          .get(snap.c.supplier_id) as { name: string } | undefined
      )?.name ?? null)
    : null;
  const rules = legalRules({
    c: snap.c,
    parsed,
    evidence: snap.evidence.map((e) => e.evidence_kind),
    policies,
    orgName: org,
    supplierName: supplier,
    allowedPrefixes: getAllowedNewContractPrefixes(db),
    isDirectStation: orgRow.is_direct_station === 1,
  });
  const findings = [...rules.findings, ...templateDiff(parsed, template)];
  const complete = requiredPolicies.every((code) =>
    policies.some((p) => p.code === code),
  );
  if (!complete)
    findings.push(
      parserFinding('POLICY_BASIS_MISSING', '现行正式制度缺失，需补充人工审查'),
    );
  handle.step({
    name: '解析与确定性检查',
    type: 'rule',
    detail: `${parsed.status} / ${findings.length} 项发现`,
  });
  handle.checkCancelled();
  handle.progress(550, '语义风险审查');
  const semantic = await semanticReview(
    parsed,
    policies,
    template,
    model,
    findings.filter((f) => f.source === 'template_diff'),
    {
      partyRole: snap.c.party_role,
      signingEntityLevel: snap.c.signing_entity_level,
      ourOrganization: org,
      counterparty: supplier ?? '',
      totalAmount: rules.elements.totalAmount as string,
      procurementTier: rules.elements.procurementTier as string,
      isImportant: String(!!Number(snap.c.is_important)),
    },
  );
  findings.push(...semantic.findings);
  const verdict = verdictFor(
    findings,
    parsed.status,
    semantic.status,
    template?.approvalStatus === 'official',
    complete,
  );
  const order = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const summary = [
    ...new Set(
      findings
        .filter(
          (f) =>
            f.severity === 'high' ||
            f.severity === 'medium' ||
            f.code === 'TEMPLATE_CANDIDATE_UNCONFIRMED',
        )
        .map((f) => f.title),
    ),
  ].slice(0, 5);
  for (const text of [
    `已核对正文与 ${policies.length} 部现行制度`,
    `当前比对范本：${template ? `${template.code} v${template.version}（${template.approvalStatus === 'official' ? '正式' : '候选'}）` : '无唯一适用范本'}`,
    `语义审查：${semantic.status === 'ok' ? '结构与证据校验通过' : '需人工补核'}`,
  ])
    if (summary.length < 3) summary.push(text);
  handle.checkCancelled();
  // Reauthorize after remote calls; no stale role/scope may write a legal conclusion.
  const original = currentAuth();
  const fresh = original
    ? loadAuthContext(db, original.userId, original.sessionId)
    : null;
  legalAccess(fresh ?? undefined, ['contract:write', 'contract:review']);
  if (fresh && !fresh.allOrgs) {
    const { resolveOrgScope, orgInScope } = await import('../security/scope');
    if (!orgInScope(resolveOrgScope(db, fresh), snap.c.org_id))
      throw new AppError('AUTH_REVOKED', '合同组织授权已撤销', 403);
  }
  const runId = db
    .transaction(() => {
      const latest = legalSnapshot(db, id);
      const cat = catalog(db, latest.c.legal_category);
      if (
        latest.fingerprint !== expectedFingerprint ||
        latest.doc?.id !== snap.doc!.id ||
        latest.c.status !== 'active' ||
        !['drafting', 'approval'].includes(latest.c.stage) ||
        JSON.stringify(cat.policies.map((p) => p.id)) !==
          JSON.stringify(policies.map((p) => p.id)) ||
        cat.template?.id !== template?.id ||
        cat.template?.approvalStatus !== template?.approvalStatus
      )
        throw new AppError(
          'LEGAL_REVIEW_STALE',
          '审核期间正文、依据或状态变化，请重新运行',
          409,
        );
      const rid = Number(
        db
          .prepare(
            `INSERT INTO ct_legal_run(contract_id,document_id,document_sha256,contract_version,context_fingerprint,policy_refs_json,template_id,template_approval_status,job_id,parse_channel,parse_status,model_status,verdict,risk_level,summary_json,elements_json,stats_json,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            id,
            snap.doc!.id,
            snap.doc!.sha256,
            snap.c.version,
            expectedFingerprint,
            JSON.stringify(
              policies.map((p) => ({
                id: p.id,
                code: p.code,
                version: p.version,
              })),
            ),
            template?.id ?? null,
            template?.approvalStatus ?? null,
            handle.id,
            parsed.channel,
            parsed.status,
            semantic.status,
            verdict,
            findings[0]?.severity ?? 'info',
            JSON.stringify(summary),
            JSON.stringify(rules.elements),
            JSON.stringify({
              ...parsed.stats,
              ...semantic.stats,
              ruleVersion: 'contract-legal-v1',
              modelFeature: 'contract_legal_review',
            }),
            currentAuth()!.userId,
            new Date().toISOString(),
          ).lastInsertRowid,
      );
      findings.forEach((f, i) =>
        db
          .prepare(
            `INSERT INTO ct_legal_finding(run_id,source,code,severity,blocking,title,message,location_ref,excerpt,expected_text,suggested_text,policy_clause_id,template_clause_id,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            rid,
            f.source,
            f.code,
            f.severity,
            f.blocking ? 1 : 0,
            f.title,
            f.message,
            f.locationRef,
            f.excerpt,
            f.expectedText,
            f.suggestedText,
            f.policyClauseId,
            f.templateClauseId,
            i,
          ),
      );
      recordEvent(db, id, 'legal.run', {
        runId: rid,
        documentId: snap.doc!.id,
        verdict,
        fingerprint: expectedFingerprint,
      });
      return rid;
    })
    .immediate();
  handle.step({ name: '法审结果已保存', type: 'system', detail: verdict });
  return { contractId: id, runId };
}
export function submitLegalReview(
  db: () => DB,
  store: () => ObjectStore,
  id: number,
  auth: AuthContext | undefined = currentAuth(),
  model?: ChatModel,
) {
  legalAccess(auth, ['contract:write', 'contract:review']);
  return db()
    .transaction(() => {
      const snap = legalSnapshot(db(), id, auth);
      if (
        snap.c.status !== 'active' ||
        !['drafting', 'approval'].includes(snap.c.stage) ||
        !snap.doc
      )
        throw new AppError(
          'CONTRACT_STATE',
          '请在合同起草或审批签署阶段上传最新正文后启动法审',
          409,
        );
      const active = db()
        .prepare(
          "SELECT id FROM app_job WHERE kind='contract.legal_review' AND status IN ('queued','running') AND json_extract(input_json,'$.contractId')=? AND json_extract(input_json,'$.fingerprint')=? LIMIT 1",
        )
        .get(id, snap.fingerprint) as { id: number } | undefined;
      if (active)
        return {
          jobId: active.id,
          contractId: id,
          documentId: snap.doc.id,
          deduplicated: true,
          done: Promise.resolve(),
        };
      const result = submitJob(
        db,
        {
          kind: 'contract.legal_review',
          title: `合同 ${snap.c.contract_no} 智能法审`,
          input: { contractId: id, fingerprint: snap.fingerprint },
          orgScopeId: snap.c.org_id,
          idempotencyKey: null,
          permission: auth!.permissions.has('contract:write')
            ? 'contract:write'
            : 'contract:review',
        },
        (h) => runReview(db(), store(), id, snap.fingerprint, h, model),
      );
      return {
        jobId: result.job.id,
        contractId: id,
        documentId: snap.doc.id,
        deduplicated: false,
        done: result.done,
      };
    })
    .immediate();
}
function runDto(db: DB, r: any, fingerprint: string): LegalRunDto {
  const findings = (
    db
      .prepare(
        'SELECT * FROM ct_legal_finding WHERE run_id=? ORDER BY sort_order',
      )
      .all(r.id) as any[]
  ).map((f) => ({
    id: f.id,
    source: f.source,
    code: f.code,
    severity: f.severity,
    blocking: !!f.blocking,
    title: f.title,
    message: f.message,
    locationRef: f.location_ref,
    excerpt: f.excerpt,
    expectedText: f.expected_text,
    suggestedText: f.suggested_text,
    policyClauseId: f.policy_clause_id,
    templateClauseId: f.template_clause_id,
  }));
  return {
    id: r.id,
    contractId: r.contract_id,
    documentId: r.document_id,
    documentSha256: r.document_sha256,
    contractVersion: r.contract_version,
    contextFingerprint: r.context_fingerprint,
    policyRefs: JSON.parse(r.policy_refs_json),
    templateId: r.template_id,
    templateApprovalStatus: r.template_approval_status,
    jobId: r.job_id,
    parseChannel: r.parse_channel,
    parseStatus: r.parse_status,
    modelStatus: r.model_status,
    verdict: r.verdict,
    riskLevel: r.risk_level,
    summary: JSON.parse(r.summary_json),
    elements: JSON.parse(r.elements_json),
    stats: JSON.parse(r.stats_json),
    createdAt: r.created_at,
    isCurrent: legalRunCurrent(db, r, fingerprint),
    findings,
  };
}
export function listLegalReviews(
  db: DB,
  id: number,
  auth = currentAuth(),
): LegalReviewsDto {
  legalAccess(auth, ['contract:read']);
  const snap = legalSnapshot(db, id, auth);
  const runs = (
    db
      .prepare(
        'SELECT * FROM ct_legal_run WHERE contract_id=? ORDER BY id DESC',
      )
      .all(id) as any[]
  ).map((r) => runDto(db, r, snap.fingerprint));
  const active = db
    .prepare(
      "SELECT id,status,progress_permille,progress_message FROM app_job WHERE kind='contract.legal_review' AND status IN ('queued','running') AND json_extract(input_json,'$.contractId')=? ORDER BY id DESC LIMIT 1",
    )
    .get(id) as any;
  const last = db
    .prepare(
      "SELECT id,status,error_message FROM app_job WHERE kind='contract.legal_review' AND json_extract(input_json,'$.contractId')=? ORDER BY id DESC LIMIT 1",
    )
    .get(id) as any;
  return {
    lastJob: last
      ? { id: last.id, status: last.status, error: last.error_message }
      : null,
    runs,
    activeJob: active
      ? {
          id: active.id,
          status: active.status,
          progress: active.progress_permille,
          message: active.progress_message,
        }
      : null,
  };
}
export function getLegalReview(
  db: DB,
  id: number,
  runId: number,
  auth = currentAuth(),
): LegalRunDto {
  const r = listLegalReviews(db, id, auth).runs.find((r) => r.id === runId);
  if (!r) throw new AppError('NOT_FOUND', '法审运行不可见', 404);
  return r;
}
