import type { DB } from '../../db/connection';
import type { AuthContext } from '../../core/request-context';
import { currentAuth } from '../../core/request-context';
import { AppError, Errors } from '../../core/errors';
import {
  policyPublishRequest,
  templatePublishRequest,
  type PolicyInput,
  type TemplateInput,
  type PolicyDto,
  type TemplateDto,
} from '../../contracts/contract-legal-review';
import { parseInput } from '../../core/validate';
import { storeFile, type ObjectStore } from '../files/object-store';
import { writeLog } from '../audit/log';
import { legalAccess } from './legal-access';
const now = () => new Date().toISOString();
const manage = (auth: AuthContext | undefined) =>
  legalAccess(auth, ['knowledge:manage'], true);
export function listLegalPolicies(
  db: DB,
  auth: AuthContext | undefined = currentAuth(),
): PolicyDto[] {
  legalAccess(auth, ['contract:read']);
  return readPolicies(db);
}
export function readPolicies(db: DB): PolicyDto[] {
  return (
    db
      .prepare('SELECT * FROM ct_legal_policy ORDER BY code,version DESC')
      .all() as any[]
  ).map((p) => ({
    id: p.id,
    code: p.code,
    version: p.version,
    title: p.title,
    docNo: p.doc_no,
    effectiveFrom: p.effective_from,
    sourceNote: p.source_note,
    status: p.status,
    sourceFileObjectId: p.source_file_object_id,
    clauses: (
      db
        .prepare(
          'SELECT * FROM ct_legal_policy_clause WHERE policy_id=? ORDER BY sort_order',
        )
        .all(p.id) as any[]
    ).map((c) => ({
      id: c.id,
      clauseNo: c.clause_no,
      chapterTitle: c.chapter_title,
      clauseText: c.clause_text,
      ruleTags: JSON.parse(c.rule_tags_json),
    })),
  }));
}
export function readTemplates(db: DB): TemplateDto[] {
  return (
    db
      .prepare('SELECT * FROM ct_legal_template ORDER BY code,version DESC')
      .all() as any[]
  ).map((t) => ({
    id: t.id,
    code: t.code,
    version: t.version,
    name: t.name,
    legalCategory: t.legal_category,
    approvalStatus: t.approval_status,
    notes: t.notes,
    sourceFileObjectId: t.source_file_object_id,
    clauses: (
      db
        .prepare(
          'SELECT * FROM ct_legal_template_clause WHERE template_id=? ORDER BY sort_order',
        )
        .all(t.id) as any[]
    ).map((c) => ({
      id: c.id,
      clauseKey: c.clause_key,
      clauseNo: c.clause_no,
      title: c.title,
      tier: c.tier,
      standardText: c.standard_text,
      defaultValueNote: c.default_value_note,
      placeholderKeys: JSON.parse(c.placeholder_keys_json),
      policyClauseRef: c.policy_clause_ref,
    })),
  }));
}
export function listLegalTemplates(
  db: DB,
  auth: AuthContext | undefined = currentAuth(),
): TemplateDto[] {
  legalAccess(auth, ['contract:read']);
  return readTemplates(db);
}
/** Draft publication must not displace an applicable official version. Ambiguous official codes remain manual. */
export function selectLegalTemplate(db: DB, category: string): TemplateDto | null {
  const templates = readTemplates(db).filter(
    (t) => t.approvalStatus !== 'retired' && t.legalCategory === category,
  );
  const official = templates.filter((t) => t.approvalStatus === 'official');
  const pool = official.length ? official : templates;
  const latest = pool.filter(
    (t) => !pool.some((q) => q.code === t.code && q.version > t.version),
  );
  return latest.length === 1 ? latest[0] : null;
}
function insertPolicy(
  db: DB,
  input: PolicyInput,
  actor: number | null,
): number {
  const id = Number(
    db
      .prepare(
        'INSERT INTO ct_legal_policy(code,version,title,doc_no,effective_from,source_note,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        input.code,
        input.version,
        input.title,
        input.docNo,
        input.effectiveFrom,
        input.sourceNote,
        actor,
        now(),
      ).lastInsertRowid,
  );
  input.clauses.forEach((c, i) =>
    db
      .prepare(
        'INSERT INTO ct_legal_policy_clause(policy_id,clause_no,chapter_title,clause_text,rule_tags_json,sort_order) VALUES(?,?,?,?,?,?)',
      )
      .run(
        id,
        c.clauseNo,
        c.chapterTitle,
        c.clauseText,
        JSON.stringify(c.ruleTags),
        i,
      ),
  );
  writeLog(db, 'contract.legal.policy.publish', 'ct_legal_policy', id, {
    code: input.code,
    version: input.version,
  });
  return id;
}
function insertTemplate(
  db: DB,
  input: TemplateInput,
  actor: number | null,
): number {
  const id = Number(
    db
      .prepare(
        'INSERT INTO ct_legal_template(code,version,name,legal_category,approval_status,notes,created_by_user_id,created_at,promoted_by_user_id,promoted_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        input.code,
        input.version,
        input.name,
        input.legalCategory,
        input.approvalStatus,
        input.notes,
        actor,
        now(),
        input.approvalStatus === 'official' ? actor : null,
        input.approvalStatus === 'official' ? now() : null,
      ).lastInsertRowid,
  );
  input.clauses.forEach((c, i) =>
    db
      .prepare(
        'INSERT INTO ct_legal_template_clause(template_id,clause_key,clause_no,title,tier,standard_text,default_value_note,placeholder_keys_json,policy_clause_ref,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        c.clauseKey,
        c.clauseNo,
        c.title,
        c.tier,
        c.standardText,
        c.defaultValueNote,
        JSON.stringify(c.placeholderKeys),
        c.policyClauseRef ?? null,
        i,
      ),
  );
  writeLog(db, 'contract.legal.template.publish', 'ct_legal_template', id, {
    code: input.code,
    version: input.version,
    notes: input.notes,
  });
  return id;
}
export function publishLegalPolicy(
  db: DB,
  input: unknown,
  auth = currentAuth(),
): PolicyDto {
  manage(auth);
  const p = parseInput(policyPublishRequest, input);
  const id = db
    .transaction(() => {
      duplicate(db, 'ct_legal_policy', p.code, p.version);
      return insertPolicy(db, p, auth!.userId);
    })
    .immediate();
  return readPolicies(db).find((p) => p.id === id)!;
}
export function publishLegalTemplate(
  db: DB,
  input: unknown,
  auth = currentAuth(),
): TemplateDto {
  manage(auth);
  const t = parseInput(templatePublishRequest, input);
  const id = db
    .transaction(() => {
      duplicate(db, 'ct_legal_template', t.code, t.version);
      return insertTemplate(db, t, auth!.userId);
    })
    .immediate();
  return readTemplates(db).find((t) => t.id === id)!;
}
function duplicate(db: DB, table: string, code: string, version: number) {
  if (
    db
      .prepare(`SELECT 1 FROM ${table} WHERE code=? AND version=?`)
      .get(code, version)
  )
    throw new AppError(
      'VERSION_CONFLICT',
      '该编码版本已发布，请发布新版本',
      409,
    );
}
export function changeLegalCatalog(
  db: DB,
  kind: 'policies' | 'templates',
  id: number,
  action: 'retire' | 'promote',
  reason: string,
  auth = currentAuth(),
): void {
  manage(auth);
  if (!reason.trim()) throw Errors.validation('请填写核定或停用说明');
  const table = kind === 'policies' ? 'ct_legal_policy' : 'ct_legal_template';
  db.transaction(() => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as any;
    if (!row) throw Errors.notFound('制度/范本');
    if (action === 'promote') {
      if (kind !== 'templates' || row.approval_status !== 'candidate')
        throw new AppError('CONTRACT_STATE', '只能转正候选范本', 409);
      db.prepare(
        `UPDATE ct_legal_template SET approval_status='official',promoted_by_user_id=?,promoted_at=? WHERE id=?`,
      ).run(auth!.userId, now(), id);
    } else {
      if ((row.status ?? row.approval_status) === 'retired')
        throw new AppError('CONTRACT_STATE', '版本已停用', 409);
      db.prepare(
        `UPDATE ${table} SET ${kind === 'policies' ? 'status' : 'approval_status'}='retired',retired_reason=?,retired_at=? WHERE id=?`,
      ).run(reason, now(), id);
    }
    writeLog(db, `contract.legal.${kind}.${action}`, table, id, { reason });
  }).immediate();
}
export function legalCatalogSource(
  db: DB,
  store: ObjectStore,
  kind: 'policies' | 'templates',
  id: number,
  auth = currentAuth(),
) {
  legalAccess(auth, ['contract:read']);
  // Catalog sources are corporate controlled documents; restricted users see structured clauses only.
  if (!auth!.allOrgs) throw Errors.notFound('制度/范本原件');
  const table = kind === 'policies' ? 'ct_legal_policy' : 'ct_legal_template';
  const f = db
    .prepare(
      `SELECT f.* FROM ${table} c JOIN file_object f ON f.id=c.source_file_object_id WHERE c.id=?`,
    )
    .get(id) as any;
  if (!f) throw Errors.notFound('原件');
  writeLog(db, 'contract.legal.source.download', table, id, {});
  return {
    fileName: f.original_name,
    contentType: f.content_type,
    content: store.read(f.sha256),
  };
}
export function attachLegalSource(
  db: DB,
  store: ObjectStore,
  kind: 'policies' | 'templates',
  id: number,
  content: Buffer,
  name: string,
  auth = currentAuth(),
): void {
  manage(auth);
  const table = kind === 'policies' ? 'ct_legal_policy' : 'ct_legal_template';
  if (!db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id))
    throw Errors.notFound('制度/范本');
  const f = storeFile(db, store, content, { originalName: name });
  db.transaction(() => {
    db.prepare(`UPDATE ${table} SET source_file_object_id=? WHERE id=?`).run(
      f.id,
      id,
    );
    writeLog(db, 'contract.legal.source.attach', table, id, {
      sha256: f.sha256,
    });
  }).immediate();
}
/** Explicit offline/CLI import only. Never called at server startup or from assistant tools. */
export function importLegalSeed(
  db: DB,
  input: { policies: unknown[]; templates: unknown[] },
): { policies: number; templates: number } {
  const ps = input.policies.map((x) => parseInput(policyPublishRequest, x));
  const ts = input.templates.map((x) => parseInput(templatePublishRequest, x));
  return db
    .transaction(() => {
      let policies = 0,
        templates = 0;
      for (const p of ps)
        if (
          !db
            .prepare('SELECT 1 FROM ct_legal_policy WHERE code=? AND version=?')
            .get(p.code, p.version)
        ) {
          insertPolicy(db, p, null);
          policies++;
        }
      for (const t of ts)
        if (
          !db
            .prepare(
              'SELECT 1 FROM ct_legal_template WHERE code=? AND version=?',
            )
            .get(t.code, t.version)
        ) {
          insertTemplate(db, t, null);
          templates++;
        }
      return { policies, templates };
    })
    .immediate();
}
