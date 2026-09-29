import type { Express, Request } from 'express';
import type { DB } from '../../db/connection';
import { Errors } from '../../core/errors';
import { parseInput } from '../../core/validate';
import type { Wrap } from '../security/http';
import { addRouteRules } from '../security/route-rules';
import type { ObjectStore } from '../files/object-store';
import { memoryUpload, sendAttachment, uploadName } from '../files/http';
import { id as idSchema, period as periodSchema } from '../../contracts/common';
import {
  STATEMENT_SCOPES, STATEMENT_SHEET_CODES, statementActivateRequest, statementUploadForm, statementVoidRequest,
} from '../../contracts/statements';
import {
  activateStatement, getStatementBatch, importStatement, listStatementBatches, previewStatement, statementItems, statementOriginal,
  statementOverview, voidStatement,
} from './statement.service';

addRouteRules([
  { method: 'GET', pattern: /^\/statements\//, permission: 'statements:read' },
  { method: 'WRITE', pattern: /^\/statements\/(preview|import|batches\/\d+\/(activate|void))$/, permission: 'statements:import' },
]);

const id = (v: unknown) => parseInput(idSchema, v);
function opt<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (value === undefined || value === '') return undefined;
  if (!allowed.includes(value as T)) throw Errors.validation('查询参数不合法');
  return value as T;
}
function formFields(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries((req.body ?? {}) as Record<string, unknown>)) if (typeof v === 'string' && v !== '') out[k] = v;
  return out;
}
function overviewQuery(req: Request) {
  return {
    orgId: req.query.orgId ? id(req.query.orgId) : undefined,
    period: req.query.period ? parseInput(periodSchema, req.query.period) : undefined,
    scope: opt(req.query.scope, STATEMENT_SCOPES),
  };
}

/** AC-F10 财务报表。服务层按报表单位 org_id 裁剪组织范围。 */
export function registerStatementRoutes(app: Express, db: () => DB, wrap: Wrap, store: () => ObjectStore): void {
  const upload = memoryUpload(['.xlsx']);
  app.post('/api/statements/preview', upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw Errors.validation('请上传财务报表 .xlsx');
    res.json(await previewStatement(db(), req.file.buffer, parseInput(statementUploadForm, formFields(req))));
  }));
  app.post('/api/statements/import', upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw Errors.validation('请上传财务报表 .xlsx');
    const batch = await importStatement(db(), store(), req.file.buffer, uploadName(req.file.originalname), parseInput(statementUploadForm, formFields(req)));
    res.status(batch.replayed ? 200 : 201).json(batch);
  }));
  app.get('/api/statements/batches', wrap((req, res) => {
    res.json(listStatementBatches(db(), { ...overviewQuery(req), status: opt(req.query.status, ['imported', 'active', 'superseded', 'voided'] as const) }));
  }));
  app.get('/api/statements/batches/:id', wrap((req, res) => { res.json(getStatementBatch(db(), id(req.params.id))); }));
  app.get('/api/statements/batches/:id/items', wrap((req, res) => { res.json(statementItems(db(), id(req.params.id), opt(req.query.sheet, STATEMENT_SHEET_CODES))); }));
  app.get('/api/statements/batches/:id/original', wrap((req, res) => {
    const f = statementOriginal(db(), store(), id(req.params.id));
    sendAttachment(res, f.fileName, f.contentType, f.content);
  }));
  app.post('/api/statements/batches/:id/activate', wrap((req, res) => {
    res.json(activateStatement(db(), id(req.params.id), parseInput(statementActivateRequest, req.body).expectedCurrentBatchId));
  }));
  app.post('/api/statements/batches/:id/void', wrap((req, res) => { res.json(voidStatement(db(), id(req.params.id), parseInput(statementVoidRequest, req.body).reason)); }));
  app.get('/api/statements/overview', wrap((req, res) => { res.json(statementOverview(db(), overviewQuery(req))); }));
}
